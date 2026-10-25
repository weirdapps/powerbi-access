// Synthetic fixtures only: no real tenant, user or token.
import type { Session } from '../src/session/store';

export function fakeJwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64(claims)}.c2lnbmF0dXJl`;
}

export const PBI_AUD = 'https://analysis.windows.net/powerbi/api';
export const TENANT = '00000000-0000-0000-0000-000000000000';
export const DS = '11111111-2222-3333-4444-555555555555';
export const WS = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

export function nowS(): number {
  return Math.floor(Date.now() / 1000);
}

export function fakeSession(over: Partial<Session> = {}): Session {
  const exp = nowS() + 3600;
  return {
    bearerToken: fakeJwt({ aud: PBI_AUD, exp, upn: 'user@example.com', tid: TENANT }),
    aud: PBI_AUD,
    exp,
    capturedAt: new Date().toISOString(),
    source: 'wire',
    account: { upn: 'user@example.com', tid: TENANT },
    ...over,
  };
}

/** A fetch stub answering each call from a queue of [status, body, headers]. */
export function fetchQueue(answers: Array<[number, unknown, Record<string, string>?]>): {
  fn: typeof fetch;
  calls: Array<{ url: string; init: RequestInit }>;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = answers.shift();
    if (!next) throw new Error('fetchQueue exhausted');
    const [status, body, headers] = next;
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return new Response(status === 204 || status === 302 ? null : text, {
      status,
      headers: headers ?? {},
    });
  }) as unknown as typeof fetch;
  return { fn, calls };
}
