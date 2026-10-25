import { afterEach, describe, expect, it } from 'vitest';

import { assertApiBase, loadConfig } from '../src/config/load';
import { ExitCode } from '../src/util/exit-codes';
import { toExit } from '../src/output/json';
import { PowerBiHttpError } from '../src/http/errors';

afterEach(() => {
  delete process.env.POWERBI_CLI_HTTP_TIMEOUT_MS;
  delete process.env.POWERBI_CLI_API_BASE;
});

describe('config', () => {
  it('defaults and env overrides', () => {
    expect(loadConfig().apiBase).toBe('https://api.powerbi.com');
    process.env.POWERBI_CLI_HTTP_TIMEOUT_MS = '1234';
    expect(loadConfig().httpTimeoutMs).toBe(1234);
    process.env.POWERBI_CLI_HTTP_TIMEOUT_MS = 'nope';
    expect(() => loadConfig()).toThrowError(expect.objectContaining({ code: ExitCode.Config }));
  });
  it('refuses to send the bearer to a non-Power BI or non-https host', () => {
    expect(assertApiBase('https://api.powerbi.com/')).toBe('https://api.powerbi.com');
    expect(() => assertApiBase('http://api.powerbi.com')).toThrow();
    expect(() => assertApiBase('https://api.powerbi.com.evil.example')).toThrow();
    expect(() => assertApiBase('not a url')).toThrow();
  });
});

describe('exit codes and toExit', () => {
  it('shared codes 0-6 are unchanged', async () => {
    const { ExitCode: E } = await import('../src/util/exit-codes');
    expect(E).toEqual({
      Success: 0,
      Internal: 1,
      InvalidInput: 2,
      Config: 3,
      AuthRequired: 4,
      Upstream: 5,
      Io: 6,
    });
  });
  it('maps HTTP errors and unknown errors', () => {
    expect(toExit(new PowerBiHttpError(401, '', 'generic')).code).toBe(ExitCode.AuthRequired);
    expect(toExit(new Error('x'))).toEqual({
      code: 1,
      payload: { code: 'internal', message: 'x' },
    });
  });
});
