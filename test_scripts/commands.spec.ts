import { afterEach, describe, expect, it, vi } from 'vitest';

import { PowerBiClient } from '../src/http/client';
import { assertId, runDatasets, runReports, runWorkspaces, scope } from '../src/commands/list';
import { normaliseKey, resolveDax, runQuery } from '../src/commands/query';
import { runSchema, SCHEMA_QUERIES } from '../src/commands/schema';
import { runAuthCheck } from '../src/commands/auth-check';
import { ExitCode } from '../src/util/exit-codes';
import { DS, WS, fakeSession, fetchQueue } from './helpers';

const opts = { apiBase: 'https://api.powerbi.com', httpTimeoutMs: 5000 };
const client = () => new PowerBiClient(fakeSession(), opts);
const rowsBody = (rows: unknown[]) => ({ results: [{ tables: [{ rows }] }] });

afterEach(() => vi.unstubAllGlobals());

describe('ids and scope', () => {
  it('accepts GUIDs and "me" only', () => {
    expect(assertId(WS.toUpperCase(), 'w')).toBe(WS);
    expect(assertId('me', 'w', true)).toBe('me');
    expect(() => assertId('me', 'w')).toThrow();
    expect(() => assertId('../x', 'w', true)).toThrow();
    expect(scope('me')).toBe('/v1.0/myorg');
    expect(scope(WS)).toBe(`/v1.0/myorg/groups/${WS}`);
  });
});

describe('list commands', () => {
  it('workspaces keeps the useful fields', async () => {
    vi.stubGlobal(
      'fetch',
      fetchQueue([[200, { value: [{ id: WS, name: 'Sample', type: 'Workspace', extra: 1 }] }]]).fn,
    );
    expect(await runWorkspaces(client())).toEqual({
      count: 1,
      workspaces: [{ id: WS, name: 'Sample', type: 'Workspace' }],
    });
  });
  it('reports and datasets address the workspace', async () => {
    const q = fetchQueue([
      [200, { value: [{ id: 'r', name: 'R', datasetId: DS }] }],
      [200, { value: [{ id: DS, name: 'D', isRefreshable: true }] }],
    ]);
    vi.stubGlobal('fetch', q.fn);
    expect((await runReports(client(), WS)).reports[0]).toEqual({
      id: 'r',
      name: 'R',
      datasetId: DS,
    });
    expect((await runDatasets(client(), 'me')).datasets[0]).toMatchObject({ id: DS });
    expect(q.calls[0].url).toMatch(`/groups/${WS}/reports`);
    expect(q.calls[1].url).toBe('https://api.powerbi.com/v1.0/myorg/datasets');
  });
});

describe('query', () => {
  it('posts one query, normalises keys and caps rows', async () => {
    const q = fetchQueue([[200, rowsBody([{ '[x]': 1 }, { '[x]': 2 }, { '[x]': 3 }])]]);
    vi.stubGlobal('fetch', q.fn);
    const r = await runQuery(client(), { dataset: DS, dax: 'EVALUATE ROW("x", 1)', maxRows: 2 });
    expect(r).toMatchObject({ rowCount: 3, returnedRows: 2, truncated: true, columns: ['x'] });
    expect(q.calls[0].url).toBe(`https://api.powerbi.com/v1.0/myorg/datasets/${DS}/executeQueries`);
    expect(JSON.parse(q.calls[0].init.body as string)).toEqual({
      queries: [{ query: 'EVALUATE ROW("x", 1)' }],
      serializerSettings: { includeNulls: true },
    });
  });
  it('a per-result error is a dax_error, exit 2', async () => {
    vi.stubGlobal(
      'fetch',
      fetchQueue([[200, { results: [{ error: { code: 'E', message: 'bad' } }] }]]).fn,
    );
    await expect(runQuery(client(), { dataset: DS, dax: 'EVALUATE 1' })).rejects.toMatchObject({
      code: ExitCode.InvalidInput,
    });
  });
  it('the ambiguous 401 surfaces as exit 5 with both causes named', async () => {
    vi.stubGlobal(
      'fetch',
      fetchQueue([[401, { error: { code: 'PowerBINotAuthorizedException' } }]]).fn,
    );
    await expect(runQuery(client(), { dataset: DS, dax: 'EVALUATE 1' })).rejects.toMatchObject({
      classified: { code: 'execute_queries_not_authorized' },
    });
  });
  it('resolves @file and rejects empty queries', () => {
    expect(resolveDax('@q.dax', () => ' EVALUATE 1 \n')).toBe('EVALUATE 1');
    expect(() => resolveDax('   ')).toThrow();
    expect(() =>
      resolveDax('@missing', () => {
        throw new Error('ENOENT');
      }),
    ).toThrowError(/cannot read/);
  });
  it('normaliseKey strips only a bare bracket pair', () => {
    expect(normaliseKey('[x]')).toBe('x');
    expect(normaliseKey('Sales[Amount]')).toBe('Sales[Amount]');
  });
});

describe('schema', () => {
  it('runs the three INFO.VIEW queries and drops hidden rows and expressions by default', async () => {
    const q = fetchQueue([
      [
        200,
        rowsBody([
          { '[Name]': 'Sales', '[IsHidden]': false },
          { '[Name]': 'H', '[IsHidden]': true },
        ]),
      ],
      [200, rowsBody([{ '[Table]': 'Sales', '[Name]': 'Amount', '[DataType]': 'Decimal' }])],
      [
        200,
        rowsBody([
          {
            '[Table]': 'Sales',
            '[Name]': 'Total',
            '[Description]': 'Sum',
            '[Expression]': 'SUM(x)',
          },
        ]),
      ],
    ]);
    vi.stubGlobal('fetch', q.fn);
    const r = await runSchema(client(), DS);
    expect(r.counts).toEqual({ tables: 1, columns: 1, measures: 1 });
    expect(r.measures[0]).toEqual({ Table: 'Sales', Name: 'Total', Description: 'Sum' });
    const sent = q.calls.map((c) => JSON.parse(c.init.body as string).queries[0].query);
    expect(sent).toEqual(Object.values(SCHEMA_QUERIES));
  });
  it('--expressions keeps the DAX', async () => {
    vi.stubGlobal(
      'fetch',
      fetchQueue([
        [200, rowsBody([])],
        [200, rowsBody([])],
        [200, rowsBody([{ '[Name]': 'T', '[Expression]': 'SUM(x)' }])],
      ]).fn,
    );
    const r = await runSchema(client(), DS, { expressions: true });
    expect(r.measures[0].Expression).toBe('SUM(x)');
  });
});

describe('auth-check', () => {
  it('reports the account and token life, never the token', async () => {
    vi.stubGlobal('fetch', fetchQueue([[200, { value: [] }]]).fn);
    const s = fakeSession();
    const r = await runAuthCheck(new PowerBiClient(s, opts), s);
    expect(r.status).toBe('ok');
    expect(r.account.upn).toBe('user@example.com');
    expect(r.secondsLeft).toBeGreaterThan(3000);
    expect(JSON.stringify(r)).not.toContain(s.bearerToken);
  });
});
