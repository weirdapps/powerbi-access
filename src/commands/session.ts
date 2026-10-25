// src/commands/session.ts
import { readSession, secondsLeft, sessionPath, type Session } from '../session/store';
import { ExitCode, ExitWithCode } from '../util/exit-codes';

/** The cached session, or exit 4 when there is none or its token has expired. */
export function requireSession(path: string = sessionPath()): Session {
  const s = readSession(path);
  if (!s) {
    throw new ExitWithCode(ExitCode.AuthRequired, {
      code: 'auth_required',
      message: `No session at ${path}. Run \`powerbi-cli login\`.`,
    });
  }
  const left = secondsLeft(s);
  if (left !== undefined && left <= 0) {
    throw new ExitWithCode(ExitCode.AuthRequired, {
      code: 'auth_required',
      message: `The cached token expired ${-left}s ago.`,
      hint: 'run "powerbi-cli auth-renew", or "powerbi-cli login" if that fails',
    });
  }
  return s;
}
