// src/auth/capture.ts
//
// Drive a real Chrome window (Playwright, persisted profile) to the Power BI
// web app and take the bearer it uses for the Power BI REST API, audience
// https://analysis.windows.net/powerbi/api.
//
// Three sources, checked together, because which one a tenant exposes varies:
//   1. wire: the Authorization header on the app's own API requests;
//   2. page-global: `window.powerBIAccessToken`, which the app keeps for itself;
//   3. msal-cache: AccessToken entries in the page's MSAL storage.
// On a Defender for Cloud Apps (MCAS) tenant the app is served from
// app.powerbi.com.mcas.ms, a separate origin. The proxy rewrites hosts, not the
// Authorization header, so the bearer is still a plain Power BI token.
import type { BrowserContext, Page } from 'playwright';

import { ExitCode, ExitWithCode } from '../util/exit-codes';
import { profileDir as defaultProfileDir, type Session } from '../session/store';
import {
  better,
  candidateFromAuthHeader,
  candidateFromToken,
  candidatesFromMsalValues,
  meetsFloor,
  toSession,
  type Candidate,
} from './token-pick';

const APP_URL = 'https://app.powerbi.com/home';
const POLL_MS = 3000;
const SETTLE_AFTER_CAPTURE_MS = 3000;

export interface CaptureOptions {
  timeoutMs: number;
  chromeChannel: string;
  headless: boolean;
  profileDir?: string;
  /** Never accept a token with fewer seconds left than this. 0 = any live token. */
  floorTtlS?: number;
}

const log = (msg: string): void => {
  process.stderr.write(`[powerbi-cli] ${msg}\n`);
};

/** Read the page-global token and the MSAL cache. Errors mean "navigating", not "absent". */
async function harvestPage(page: Page): Promise<Candidate[]> {
  const dump = await page.evaluate(() => {
    const w = window as unknown as { powerBIAccessToken?: unknown };
    const values: string[] = [];
    for (const store of [window.localStorage, window.sessionStorage]) {
      try {
        for (let i = 0; i < store.length; i++) {
          const k = store.key(i);
          if (k) values.push(store.getItem(k) ?? '');
        }
      } catch {
        /* storage blocked on this origin */
      }
    }
    return {
      global: typeof w.powerBIAccessToken === 'string' ? w.powerBIAccessToken : null,
      values,
    };
  });
  const out = candidatesFromMsalValues(dump.values);
  if (dump.global) {
    const g = candidateFromToken(dump.global, 'page-global');
    if (g) out.push(g);
  }
  return out;
}

/** Host and path only: query strings can carry login hints and state. */
function hostAndPath(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return '(unknown)';
  }
}

async function onSignInPage(page: Page): Promise<boolean> {
  try {
    if (
      /login\.microsoftonline\.com|login\.live\.com|certificate-checker|\/singleSignOn|\/signin/i.test(
        page.url(),
      )
    ) {
      return true;
    }
    // The Microsoft sign-in form, or the Power BI landing page's own email prompt.
    return (
      (await page
        .locator('input[name=loginfmt], input[type=password], input[type=email], #email')
        .count()) > 0
    );
  } catch {
    return false;
  }
}

/** Answer "Stay signed in?" with Yes: it writes the cookie that silent renewal needs. */
async function acceptStaySignedIn(page: Page): Promise<void> {
  try {
    const yes = page.locator('#idSIButton9, input[type=submit][value="Yes"]').first();
    const kmsi = page.locator('#KmsiCheckboxField, input[name="DontShowAgain"]').first();
    if (!(await kmsi.isVisible({ timeout: 500 }))) return;
    await kmsi.click({ timeout: 2000 }).catch(() => undefined);
    if (await yes.isVisible({ timeout: 2000 })) {
      await yes.click({ timeout: 3000 });
      log('answered "Stay signed in?" with Yes so the session persists');
    }
  } catch {
    /* not shown on this tenant */
  }
}

/** Click through the MCAS "Redirect Notice" page, which otherwise never moves on. */
async function clearMcasInterstitial(page: Page): Promise<void> {
  try {
    if (!/mcas-proxyweb\.mcas\.ms|certificate-checker/i.test(page.url())) return;
    const link = page.locator('a:has-text("Proceed to")').first();
    if (await link.isVisible({ timeout: 3000 })) {
      await link.click({ timeout: 5000 });
      log('cleared an MCAS redirect notice');
    }
  } catch {
    /* best effort */
  }
}

export async function captureSession(opts: CaptureOptions): Promise<Session> {
  let chromium: typeof import('playwright').chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    throw new ExitWithCode(ExitCode.Config, {
      code: 'playwright_missing',
      message: 'Playwright is not installed. Run `npm install` (it is an optional dependency).',
    });
  }
  const floorS = opts.floorTtlS ?? 0;
  let best: Candidate | null = null;
  const hostsSeen = new Set<string>();
  let context: BrowserContext | undefined;

  const offer = (c: Candidate | null): void => {
    if (!c || !meetsFloor(c, floorS)) return;
    const prev = best;
    best = better(best, c);
    if (best !== prev) log(`captured a Power BI token from ${c.source}`);
  };

  try {
    context = await chromium.launchPersistentContext(opts.profileDir ?? defaultProfileDir(), {
      channel: opts.chromeChannel,
      headless: opts.headless,
      viewport: null,
    });
    context.on('request', (req) => {
      const c = candidateFromAuthHeader(req.headers()['authorization']);
      if (!c) return;
      try {
        const host = new URL(req.url()).host;
        if (!hostsSeen.has(host)) {
          hostsSeen.add(host);
          log(`bearer seen on requests to ${host}`);
        }
      } catch {
        /* ignore */
      }
      offer(c);
    });

    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch((e) => {
      log(`navigation warning: ${(e as Error).message}`);
    });

    const deadline = Date.now() + opts.timeoutMs;
    let announced = false;
    let lastWhere = '';
    while (Date.now() < deadline) {
      const where = hostAndPath(page.url());
      if (where !== lastWhere) {
        log(`page at ${where}`);
        lastWhere = where;
      }
      await clearMcasInterstitial(page);
      if (await onSignInPage(page)) {
        if (opts.headless) {
          throw new ExitWithCode(ExitCode.AuthRequired, {
            code: 'auth_renew_failed',
            message:
              'Headless renewal landed on a sign-in page: the persisted profile is signed out. Run `powerbi-cli login`.',
          });
        }
        await acceptStaySignedIn(page);
        if (!announced) {
          log('sign-in required: finish it in the Chrome window; nothing navigates meanwhile');
          announced = true;
        }
      } else {
        try {
          for (const c of await harvestPage(page)) offer(c);
        } catch {
          /* page navigating; the next tick retries */
        }
        if (best) break;
      }
      await page.waitForTimeout(POLL_MS);
    }

    if (!best) {
      throw new ExitWithCode(ExitCode.AuthRequired, {
        code: 'auth_required',
        message:
          `No Power BI token captured within ${opts.timeoutMs}ms` +
          (floorS ? ` with at least ${floorS}s left` : '') +
          `. Bearer hosts seen: ${hostsSeen.size ? [...hostsSeen].join(', ') : '(none)'}.`,
      });
    }
    // Let the app finish its startup calls; a fresher token may arrive.
    await page.waitForTimeout(SETTLE_AFTER_CAPTURE_MS);
    try {
      for (const c of await harvestPage(page)) offer(c);
    } catch {
      /* keep what we have */
    }
    return toSession(best);
  } finally {
    await context?.close().catch(() => undefined);
  }
}
