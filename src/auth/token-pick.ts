// src/auth/token-pick.ts
//
// Pure helpers behind the browser capture, kept apart so they are testable
// without a browser.
import { decodeJwt } from '../session/jwt';
import { POWERBI_AUDIENCE, type Session, type TokenSource } from '../session/store';

export interface Candidate {
  token: string;
  aud: string;
  exp?: number;
  scp?: string;
  appid?: string;
  upn?: string;
  oid?: string;
  tid?: string;
  source: TokenSource;
}

/** True for the Power BI API audience, with or without a trailing slash. */
export function isPowerBiAudience(aud: unknown): boolean {
  return typeof aud === 'string' && aud.replace(/\/+$/, '').toLowerCase() === POWERBI_AUDIENCE;
}

/** Decode a raw JWT into a candidate, or null if it is not a Power BI token. */
export function candidateFromToken(token: string, source: TokenSource): Candidate | null {
  const t = token.trim();
  if (t.split('.').length !== 3) return null;
  let c;
  try {
    c = decodeJwt(t);
  } catch {
    return null;
  }
  if (!isPowerBiAudience(c.aud)) return null;
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
  return {
    token: t,
    aud: POWERBI_AUDIENCE,
    exp: typeof c.exp === 'number' ? c.exp : undefined,
    scp: str(c.scp),
    appid: str(c.appid) ?? str(c.azp),
    upn: str(c.upn) ?? str(c.unique_name) ?? str(c.preferred_username),
    oid: str(c.oid),
    tid: str(c.tid),
    source,
  };
}

/** A candidate from an `Authorization: Bearer ...` header value. */
export function candidateFromAuthHeader(header: string | undefined): Candidate | null {
  if (!header || !/^Bearer\s+/i.test(header)) return null;
  return candidateFromToken(header.replace(/^Bearer\s+/i, ''), 'wire');
}

/**
 * Candidates from a dump of MSAL browser storage values. MSAL stores each
 * access token as JSON with credentialType "AccessToken", the scopes in
 * `target` and the JWT in `secret`.
 */
export function candidatesFromMsalValues(values: string[]): Candidate[] {
  const out: Candidate[] = [];
  for (const v of values) {
    let entry: { credentialType?: unknown; target?: unknown; secret?: unknown };
    try {
      entry = JSON.parse(v);
    } catch {
      continue;
    }
    if (entry?.credentialType !== 'AccessToken' || typeof entry.secret !== 'string') continue;
    if (
      typeof entry.target === 'string' &&
      !/analysis\.windows\.net\/powerbi\/api/i.test(entry.target)
    )
      continue;
    const c = candidateFromToken(entry.secret, 'msal-cache');
    if (c) out.push(c);
  }
  return out;
}

/** Keep the candidate with the most life left; ties keep the incumbent. */
export function better(a: Candidate | null, b: Candidate | null): Candidate | null {
  if (!a) return b;
  if (!b) return a;
  return (b.exp ?? 0) > (a.exp ?? 0) ? b : a;
}

/** True when the candidate has at least `floorS` seconds left (unknown exp passes). */
export function meetsFloor(c: Candidate, floorS: number, nowS = Math.floor(Date.now() / 1000)) {
  return c.exp === undefined || c.exp - nowS >= floorS;
}

export function toSession(c: Candidate, now = new Date()): Session {
  return {
    bearerToken: c.token,
    aud: c.aud,
    exp: c.exp,
    scp: c.scp,
    appid: c.appid,
    capturedAt: now.toISOString(),
    source: c.source,
    account: { upn: c.upn, oid: c.oid, tid: c.tid },
  };
}
