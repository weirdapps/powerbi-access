import { mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readSession, sessionPath, writeSession, secondsLeft } from '../src/session/store';
import { requireSession } from '../src/commands/session';
import { ExitCode } from '../src/util/exit-codes';
import { fakeSession, nowS } from './helpers';

let oldHome: string | undefined;
beforeEach(() => {
  oldHome = process.env.HOME;
  process.env.HOME = mkdtempSync(join(tmpdir(), 'pbi-cli-'));
  delete process.env.POWERBI_CLI_SESSION_FILE;
});
afterEach(() => {
  process.env.HOME = oldHome;
});

describe('session store', () => {
  it('writes 0600 in a 0700 dir and reads back', () => {
    const s = fakeSession();
    writeSession(s);
    const p = sessionPath();
    expect(p).toMatch(/\.powerbi-cli\/session\.json$/);
    expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(statSync(join(process.env.HOME!, '.powerbi-cli')).mode & 0o777).toBe(0o700);
    expect(readSession()).toEqual(s);
  });
  it('treats a missing or tokenless file as no session', () => {
    expect(readSession()).toBeNull();
    writeSession(fakeSession());
    writeFileSync(sessionPath(), '{}');
    expect(readSession()).toBeNull();
  });
  it('requireSession exits 4 when absent or expired', () => {
    expect(() => requireSession()).toThrowError(
      expect.objectContaining({ code: ExitCode.AuthRequired }),
    );
    writeSession(fakeSession({ exp: nowS() - 10 }));
    expect(() => requireSession()).toThrowError(
      expect.objectContaining({ code: ExitCode.AuthRequired }),
    );
    writeSession(fakeSession());
    expect(requireSession().aud).toMatch(/powerbi/);
  });
  it('secondsLeft is undefined without exp', () => {
    expect(secondsLeft(fakeSession({ exp: undefined }))).toBeUndefined();
  });
});
