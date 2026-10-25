// src/commands/login.ts
import { captureSession } from '../auth/capture';
import { acquireLock } from '../auth/lock';
import { lockPath, sessionPath, writeSession, type Session } from '../session/store';
import { ExitCode, ExitWithCode } from '../util/exit-codes';
import type { Config } from '../config/load';

export interface LoginResult {
  status: 'ok';
  sessionFile: string;
  source: Session['source'];
  tokenExpiresAt?: string;
  account: { upn?: string };
}

export type Capture = typeof captureSession;

export function summarise(session: Session, file: string): LoginResult {
  return {
    status: 'ok',
    sessionFile: file,
    source: session.source,
    tokenExpiresAt: session.exp ? new Date(session.exp * 1000).toISOString() : undefined,
    account: { upn: session.account?.upn },
  };
}

async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  let release: () => Promise<void>;
  try {
    release = await acquireLock(lockPath());
  } catch (err) {
    throw new ExitWithCode(ExitCode.Upstream, {
      code: 'browser_locked',
      message: `${err instanceof Error ? err.message : String(err)}. Transient; retry when the other run ends.`,
    });
  }
  try {
    return await fn();
  } finally {
    await release().catch(() => undefined);
  }
}

export async function runLogin(config: Config, capture: Capture = captureSession) {
  return withLock(async () => {
    const session = await capture({
      timeoutMs: config.loginTimeoutMs,
      chromeChannel: config.chromeChannel,
      headless: false,
    });
    writeSession(session);
    return summarise(session, sessionPath());
  });
}

/** Renewal refuses a token with less than this left, so a caller gets a usable hour. */
export const RENEW_FLOOR_TTL_S = 900;
const DEFAULT_RENEW_TIMEOUT_MS = 90_000;

/** Classify a capture failure: a dead network is not a reason to log in again. */
export function classifyCaptureFailure(message: string) {
  if (/net::ERR_|browserType\.launch/.test(message)) return ExitCode.Upstream;
  return ExitCode.AuthRequired;
}

export async function runAuthRenew(config: Config, capture: Capture = captureSession) {
  return withLock(async () => {
    let session: Session;
    try {
      session = await capture({
        timeoutMs: Math.min(config.loginTimeoutMs, DEFAULT_RENEW_TIMEOUT_MS),
        chromeChannel: config.chromeChannel,
        headless: true,
        floorTtlS: RENEW_FLOOR_TTL_S,
      });
    } catch (err) {
      if (err instanceof ExitWithCode) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      if (classifyCaptureFailure(msg) === ExitCode.Upstream) {
        throw new ExitWithCode(ExitCode.Upstream, {
          code: 'auth_renew_unreachable',
          message: `Headless renewal could not reach Microsoft: ${msg}. Transient; no login needed.`,
        });
      }
      throw new ExitWithCode(ExitCode.AuthRequired, {
        code: 'auth_renew_failed',
        message: `Headless renewal failed: ${msg}. Run \`powerbi-cli login\`.`,
      });
    }
    writeSession(session);
    return summarise(session, sessionPath());
  });
}
