import { afterEach, describe, expect, it, vi } from 'vitest';

import { PowerBiClient, classifyRedirect } from '../src/http/client';
import { PowerBiHttpError } from '../src/http/errors';
import { ExitCode, ExitWithCode } from '../src/util/exit-codes';
import { fakeSession, fetchQueue } from './helpers';

const opts = { apiBase: 'https://api.powerbi.com', httpTimeoutMs: 5000 };

afterEach(() => vi.unstubAllGlobals());

describe('PowerBiClient', () => {
  it('sends the bearer and parses JSON (BOM tolerated)', async () => {
    const q = fetchQueue([[200, '﻿{"value":[]}']]);
    vi.stubGlobal('fetch', q.fn);
    const s = fakeSession();
    const r = await new PowerBiClient(s, opts).get<{ value: unknown[] }>('/v1.0/myorg/groups');
    expect(r.value).toEqual([]);
    const h = q.calls[0].init.headers as Record<string, string>;
    expect(h.Authorization).toBe(`Bearer ${s.bearerToken}`);
    expect(q.calls[0].url).toBe('https://api.powerbi.com/v1.0/myorg/groups');
    expect(q.calls[0].init.redirect).toBe('manual');
  });

  it('raises a classified PowerBiHttpError with the request id', async () => {
    vi.stubGlobal(
      'fetch',
      fetchQueue([
        [401, { error: { code: 'PowerBINotAuthorizedException' } }, { RequestId: 'rid' }],
      ]).fn,
    );
    const p = new PowerBiClient(fakeSession(), opts).post('/x', {}, 'executeQueries');
    await expect(p).rejects.toBeInstanceOf(PowerBiHttpError);
    await p.catch((e: PowerBiHttpError) => {
      expect(e.classified.code).toBe('execute_queries_not_authorized');
      expect(e.requestId).toBe('rid');
    });
  });

  it('never follows a redirect; sign-in landing is exit 4', async () => {
    vi.stubGlobal(
      'fetch',
      fetchQueue([[302, '', { location: 'https://login.microsoftonline.com/x' }]]).fn,
    );
    await expect(new PowerBiClient(fakeSession(), opts).get('/y')).rejects.toMatchObject({
      code: ExitCode.AuthRequired,
    });
  });

  it('a network failure is exit 5, after retries', async () => {
    const err = Object.assign(new Error('boom'), { code: 'ECONNRESET' });
    const fn = vi.fn().mockRejectedValue(err);
    vi.stubGlobal('fetch', fn);
    await expect(new PowerBiClient(fakeSession(), opts).get('/z')).rejects.toMatchObject({
      code: ExitCode.Upstream,
    });
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('rejects a malformed path', async () => {
    await expect(new PowerBiClient(fakeSession(), opts).get('//evil')).rejects.toBeInstanceOf(
      ExitWithCode,
    );
  });
});

describe('classifyRedirect', () => {
  it('MCAS landing is auth, other hosts are upstream', () => {
    expect(classifyRedirect('https://app.powerbi.com.mcas.ms/').code).toBe(ExitCode.AuthRequired);
    expect(classifyRedirect('https://elsewhere.example/').code).toBe(ExitCode.Upstream);
    expect(classifyRedirect(null).code).toBe(ExitCode.Upstream);
  });
});
