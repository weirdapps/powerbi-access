// src/commands/query.ts
//
// DAX through POST /datasets/{id}/executeQueries. One query per request (the
// API's own limit); the API caps a result at 100k rows / 1M values, and this
// CLI caps what it prints at --max-rows.
import { readFileSync } from 'node:fs';

import { PowerBiClient } from '../http/client';
import { ExitCode, ExitWithCode } from '../util/exit-codes';
import { assertId, scope } from './list';

export const DEFAULT_MAX_ROWS = 500;

interface ExecuteQueriesResponse {
  results?: Array<{
    tables?: Array<{ rows?: Array<Record<string, unknown>> }>;
    error?: { code?: string; message?: string };
  }>;
  error?: { code?: string; message?: string };
}

/** `--dax` takes the query text, or `@path` to read it from a file. */
export function resolveDax(
  raw: string,
  read: (p: string) => string = (p) => readFileSync(p, 'utf8'),
) {
  let text = raw;
  if (raw.startsWith('@')) {
    try {
      text = read(raw.slice(1));
    } catch (err) {
      throw new ExitWithCode(ExitCode.Io, {
        code: 'io',
        message: `cannot read DAX file ${raw.slice(1)}: ${(err as Error).message}`,
      });
    }
  }
  text = text.trim();
  if (!text) {
    throw new ExitWithCode(ExitCode.InvalidInput, {
      code: 'invalid_input',
      message: 'empty DAX query',
    });
  }
  return text;
}

/** "[x]" becomes "x"; "Table[Column]" stays as it is, since the table is information. */
export function normaliseKey(k: string): string {
  const m = /^\[(.*)\]$/.exec(k);
  return m ? m[1] : k;
}

export function normaliseRows(rows: Array<Record<string, unknown>>) {
  return rows.map((r) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) out[normaliseKey(k)] = v;
    return out;
  });
}

export async function executeDax(
  client: PowerBiClient,
  datasetId: string,
  dax: string,
  workspace?: string,
): Promise<Array<Record<string, unknown>>> {
  const ds = assertId(datasetId, '--dataset');
  const base = workspace ? scope(assertId(workspace, '--workspace', true)) : '/v1.0/myorg';
  const resp = await client.post<ExecuteQueriesResponse>(
    `${base}/datasets/${ds}/executeQueries`,
    { queries: [{ query: dax }], serializerSettings: { includeNulls: true } },
    'executeQueries',
  );
  const result = resp?.results?.[0];
  const err = result?.error ?? resp?.error;
  if (err) {
    throw new ExitWithCode(ExitCode.InvalidInput, {
      code: 'dax_error',
      message: `The model rejected the DAX query: ${err.message ?? err.code ?? 'no detail'}`,
    });
  }
  return normaliseRows(result?.tables?.[0]?.rows ?? []);
}

export interface QueryOptions {
  dataset: string;
  dax: string;
  maxRows?: number;
  workspace?: string;
}

export async function runQuery(client: PowerBiClient, opts: QueryOptions) {
  const dax = resolveDax(opts.dax);
  const maxRows = opts.maxRows ?? DEFAULT_MAX_ROWS;
  const rows = await executeDax(client, opts.dataset, dax, opts.workspace);
  const kept = rows.slice(0, maxRows);
  return {
    dataset: opts.dataset.toLowerCase(),
    rowCount: rows.length,
    returnedRows: kept.length,
    truncated: rows.length > kept.length,
    columns: kept.length ? Object.keys(kept[0]) : [],
    rows: kept,
  };
}
