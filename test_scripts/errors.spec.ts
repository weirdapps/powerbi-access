import { describe, expect, it } from 'vitest';

import { classify, parsePbiError, PowerBiHttpError } from '../src/http/errors';
import { ExitCode } from '../src/util/exit-codes';

const pbi = (code: string, detail?: string) =>
  JSON.stringify({
    error: {
      code,
      'pbi.error': {
        code,
        parameters: {},
        details: detail ? [{ code: 'DetailsMessage', detail: { type: 1, value: detail } }] : [],
      },
    },
  });

describe('parsePbiError', () => {
  it('reads code and first detail', () => {
    expect(parsePbiError(pbi('DatasetExecuteQueriesError', 'Query (1, 1) bad'))).toEqual({
      code: 'DatasetExecuteQueriesError',
      message: undefined,
      detail: 'Query (1, 1) bad',
    });
  });
  it('tolerates non-JSON', () => {
    expect(parsePbiError('<html>')).toEqual({});
  });
});

describe('classify', () => {
  it('401 with no Power BI code means re-authenticate', () => {
    expect(classify(401, '', 'generic').exit).toBe(ExitCode.AuthRequired);
  });
  it('TokenExpired means re-authenticate, whatever the status', () => {
    const body = JSON.stringify({ error: { code: 'TokenExpired', message: 'expired' } });
    const c = classify(403, body, 'executeQueries');
    expect(c.exit).toBe(ExitCode.AuthRequired);
    expect(c.code).toBe('auth_required');
  });
  it('executeQueries 401 PowerBINotAuthorizedException is the ambiguous permission case, exit 5', () => {
    const c = classify(401, pbi('PowerBINotAuthorizedException'), 'executeQueries', 'req-1');
    expect(c.exit).toBe(ExitCode.Upstream);
    expect(c.code).toBe('execute_queries_not_authorized');
    expect(c.message).toMatch(/Build/);
    expect(c.message).toMatch(/Dataset Execute Queries REST API/);
    expect(c.message).toMatch(/req=req-1/);
  });
  it('wording that names the tenant switch is classified as disabled', () => {
    const body = JSON.stringify({
      error: { code: 'PowerBINotAuthorizedException', message: 'blocked by tenant setting' },
    });
    expect(classify(403, body, 'executeQueries').code).toBe('execute_queries_disabled');
  });
  it('the same 401 on a non-query call is plain access_denied', () => {
    expect(classify(401, pbi('PowerBINotAuthorizedException'), 'generic').code).toBe(
      'access_denied',
    );
  });
  it('DAX error is invalid input and proves the API is open', () => {
    const c = classify(400, pbi('DatasetExecuteQueriesError', 'syntax'), 'executeQueries');
    expect(c.exit).toBe(ExitCode.InvalidInput);
    expect(c.code).toBe('dax_error');
    expect(c.message).toMatch(/syntax/);
    expect(c.message).toMatch(/enabled/);
  });
  it('404 and PowerBIEntityNotFound are not_found', () => {
    expect(classify(404, pbi('PowerBIEntityNotFound'), 'executeQueries').code).toBe('not_found');
  });
  it('429 is throttled, 5xx upstream, other 400 bad_request', () => {
    expect(classify(429, '', 'generic').code).toBe('throttled');
    expect(classify(503, 'down', 'generic').code).toBe('upstream');
    expect(classify(400, pbi('InvalidRequest'), 'generic').exit).toBe(ExitCode.InvalidInput);
  });
  it('redacts token-shaped text in upstream messages', () => {
    const c = classify(500, 'Bearer abc.def.ghi ' + 'x'.repeat(60), 'generic');
    expect(c.message).not.toMatch(/abc\.def\.ghi/);
    expect(c.message).not.toMatch(/x{60}/);
  });
});

describe('PowerBiHttpError.toExit', () => {
  it('carries status, pbiCode, requestId and hint', () => {
    const e = new PowerBiHttpError(
      401,
      pbi('PowerBINotAuthorizedException'),
      'executeQueries',
      'r',
    );
    const x = e.toExit();
    expect(x.code).toBe(ExitCode.Upstream);
    expect(x.payload).toMatchObject({
      code: 'execute_queries_not_authorized',
      status: 401,
      pbiCode: 'PowerBINotAuthorizedException',
      requestId: 'r',
    });
    expect(x.payload.hint).toMatch(/My workspace/);
  });
});
