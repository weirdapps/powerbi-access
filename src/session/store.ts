// src/session/store.ts
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  chmodSync,
  renameSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';
import { randomBytes } from 'node:crypto';

/** The audience of every token the Power BI REST API accepts. */
export const POWERBI_AUDIENCE = 'https://analysis.windows.net/powerbi/api';

/**
 * wire: the Authorization header of a request the web app sent.
 * page-global: the `powerBIAccessToken` variable the web app keeps on `window`.
 * msal-cache: an AccessToken entry in the page's MSAL storage.
 */
export type TokenSource = 'wire' | 'page-global' | 'msal-cache';

export interface Session {
  // The Power BI API bearer, captured from the web app's own requests or
  // from its MSAL cache. Never printed; only its claims are reported.
  bearerToken: string;
  aud: string;
  exp?: number;
  scp?: string;
  appid?: string;
  capturedAt: string;
  // Where the token was found: see TokenSource.
  source: TokenSource;
  account?: { upn?: string; oid?: string; tid?: string };
}

const HOME = () => process.env.HOME ?? homedir();
export const stateDir = (): string => join(HOME(), '.powerbi-cli');
export const sessionPath = (): string =>
  process.env.POWERBI_CLI_SESSION_FILE ?? join(stateDir(), 'session.json');
export const profileDir = (): string => join(stateDir(), 'playwright-profile');
export const lockPath = (): string => join(stateDir(), '.browser.lock');

export function ensureStateDir(): void {
  const dir = stateDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } else if (platform() !== 'win32') {
    const current = statSync(dir).mode & 0o777;
    if (current !== 0o700) chmodSync(dir, 0o700);
  }
}

export function writeSession(session: Session, path: string = sessionPath()): void {
  ensureStateDir();
  const tmpPath = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(session, null, 2), { mode: 0o600 });
  renameSync(tmpPath, path);
  if (platform() !== 'win32') {
    chmodSync(path, 0o600);
  }
}

export function readSession(path: string = sessionPath()): Session | null {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, 'utf8');
  const parsed = JSON.parse(raw) as Partial<Session>;
  if (typeof parsed.bearerToken !== 'string' || parsed.bearerToken.length === 0) return null;
  return parsed as Session;
}

/** Seconds of life left on the session's token, or undefined when unknown. */
export function secondsLeft(session: Session, nowS = Math.floor(Date.now() / 1000)) {
  return typeof session.exp === 'number' ? session.exp - nowS : undefined;
}
