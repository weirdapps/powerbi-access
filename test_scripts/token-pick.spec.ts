import { describe, expect, it } from 'vitest';

import {
  better,
  candidateFromAuthHeader,
  candidateFromToken,
  candidatesFromMsalValues,
  isPowerBiAudience,
  meetsFloor,
  toSession,
} from '../src/auth/token-pick';
import { fakeJwt, nowS, PBI_AUD, TENANT } from './helpers';

describe('token-pick', () => {
  it('recognises the Power BI audience with or without trailing slash', () => {
    expect(isPowerBiAudience(PBI_AUD)).toBe(true);
    expect(isPowerBiAudience(PBI_AUD + '/')).toBe(true);
    expect(isPowerBiAudience('https://graph.microsoft.com')).toBe(false);
    expect(isPowerBiAudience(undefined)).toBe(false);
  });

  it('takes a Power BI bearer off the wire and ignores other audiences', () => {
    const t = fakeJwt({ aud: PBI_AUD, exp: 10, upn: 'user@example.com', tid: TENANT });
    const c = candidateFromAuthHeader(`Bearer ${t}`);
    expect(c).toMatchObject({ source: 'wire', exp: 10, upn: 'user@example.com' });
    expect(
      candidateFromAuthHeader(`Bearer ${fakeJwt({ aud: 'https://graph.microsoft.com' })}`),
    ).toBeNull();
    expect(candidateFromAuthHeader('Basic abc')).toBeNull();
    expect(candidateFromAuthHeader(undefined)).toBeNull();
    expect(candidateFromToken('not-a-jwt', 'page-global')).toBeNull();
  });

  it('reads MSAL AccessToken entries scoped to Power BI only', () => {
    const pbi = fakeJwt({ aud: PBI_AUD, exp: 20 });
    const graph = fakeJwt({ aud: 'https://graph.microsoft.com', exp: 30 });
    const values = [
      JSON.stringify({ credentialType: 'AccessToken', target: `${PBI_AUD}/.default`, secret: pbi }),
      JSON.stringify({ credentialType: 'AccessToken', target: 'User.Read', secret: graph }),
      JSON.stringify({ credentialType: 'RefreshToken', secret: 'r' }),
      'not json',
    ];
    const got = candidatesFromMsalValues(values);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ source: 'msal-cache', exp: 20 });
  });

  it('prefers the token with more life, applies the floor, builds a session', () => {
    const a = candidateFromToken(fakeJwt({ aud: PBI_AUD, exp: nowS() + 100 }), 'wire')!;
    const b = candidateFromToken(fakeJwt({ aud: PBI_AUD, exp: nowS() + 3000 }), 'page-global')!;
    expect(better(a, b)).toBe(b);
    expect(better(b, a)).toBe(b);
    expect(better(null, a)).toBe(a);
    expect(meetsFloor(a, 900)).toBe(false);
    expect(meetsFloor(b, 900)).toBe(true);
    const s = toSession(b);
    expect(s).toMatchObject({ aud: PBI_AUD, source: 'page-global' });
    expect(s.bearerToken).toBe(b.token);
  });
});
