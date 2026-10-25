import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  classifyCaptureFailure,
  runAuthRenew,
  runLogin,
  RENEW_FLOOR_TTL_S,
} from '../src/commands/login';
import { loadConfig } from '../src/config/load';
import { readSession, sessionPath } from '../src/session/store';
import { ExitCode, ExitWithCode } from '../src/util/exit-codes';
import { fakeSession } from './helpers';

let oldHome: string | undefined;
beforeEach(() => {
  oldHome = process.env.HOME;
  process.env.HOME = mkdtempSync(join(tmpdir(), 'pbi-cli-'));
});
afterEach(() => {
  process.env.HOME = oldHome;
});

describe('login / auth-renew', () => {
  it('login captures headed, persists 0600 and never echoes the token', async () => {
    const s = fakeSession();
    const capture = vi.fn().mockResolvedValue(s);
    const r = await runLogin(loadConfig(), capture);
    expect(capture.mock.calls[0][0]).toMatchObject({ headless: false });
    expect(readSession()).toEqual(s);
    expect(statSync(sessionPath()).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(r)).not.toContain(s.bearerToken);
    expect(r.account.upn).toBe('user@example.com');
  });
  it('auth-renew runs headless with the TTL floor', async () => {
    const capture = vi.fn().mockResolvedValue(fakeSession());
    await runAuthRenew(loadConfig(), capture);
    expect(capture.mock.calls[0][0]).toMatchObject({
      headless: true,
      floorTtlS: RENEW_FLOOR_TTL_S,
    });
  });
  it('a network failure during renew is exit 5, anything else exit 4', async () => {
    await expect(
      runAuthRenew(
        loadConfig(),
        vi.fn().mockRejectedValue(new Error('net::ERR_NAME_NOT_RESOLVED')),
      ),
    ).rejects.toMatchObject({ code: ExitCode.Upstream });
    await expect(
      runAuthRenew(loadConfig(), vi.fn().mockRejectedValue(new Error('page closed'))),
    ).rejects.toMatchObject({ code: ExitCode.AuthRequired });
    const own = new ExitWithCode(ExitCode.AuthRequired, { code: 'auth_renew_failed' });
    await expect(runAuthRenew(loadConfig(), vi.fn().mockRejectedValue(own))).rejects.toBe(own);
  });
  it('classifyCaptureFailure', () => {
    expect(classifyCaptureFailure('browserType.launch: failed')).toBe(ExitCode.Upstream);
    expect(classifyCaptureFailure('timeout')).toBe(ExitCode.AuthRequired);
  });
});
