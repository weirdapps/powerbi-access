// src/commands/auth-check.ts
import { PowerBiClient } from '../http/client';
import { secondsLeft, type Session } from '../session/store';

export interface AuthCheckResult {
  status: 'ok';
  account: { upn?: string };
  source: Session['source'];
  tokenExpiresAt?: string;
  secondsLeft?: number;
  scopes?: string;
}

/** One cheap authenticated read: the first workspace the token can see. */
export async function runAuthCheck(client: PowerBiClient, session: Session) {
  await client.get('/v1.0/myorg/groups?$top=1');
  const result: AuthCheckResult = {
    status: 'ok',
    account: { upn: session.account?.upn },
    source: session.source,
    tokenExpiresAt: session.exp ? new Date(session.exp * 1000).toISOString() : undefined,
    secondsLeft: secondsLeft(session),
    scopes: session.scp,
  };
  return result;
}
