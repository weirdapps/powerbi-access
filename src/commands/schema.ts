// src/commands/schema.ts
//
// The model's tables, columns and measures, with descriptions, through the
// DAX INFO.VIEW functions. Unlike INFO.*, the INFO.VIEW family is readable by
// anyone who may query the model, so this needs Build and nothing more.
import { PowerBiClient } from '../http/client';
import { executeDax } from './query';

export const SCHEMA_QUERIES = {
  tables: 'EVALUATE INFO.VIEW.TABLES()',
  columns: 'EVALUATE INFO.VIEW.COLUMNS()',
  measures: 'EVALUATE INFO.VIEW.MEASURES()',
} as const;

const KEEP: Record<keyof typeof SCHEMA_QUERIES, string[]> = {
  tables: ['Name', 'Description', 'IsHidden', 'StorageMode'],
  columns: ['Table', 'Name', 'DataType', 'Description', 'IsHidden', 'FormatString'],
  measures: ['Table', 'Name', 'Description', 'Expression', 'FormatString', 'IsHidden'],
};

/** Keep the listed fields when present; a field this engine version lacks is just absent. */
export function slim(rows: Array<Record<string, unknown>>, keys: string[]) {
  return rows.map((r) => {
    const out: Record<string, unknown> = {};
    for (const k of keys) if (r[k] !== undefined) out[k] = r[k];
    return out;
  });
}

export async function runSchema(
  client: PowerBiClient,
  datasetId: string,
  opts: { workspace?: string; includeHidden?: boolean; expressions?: boolean } = {},
) {
  const out: Record<string, Array<Record<string, unknown>>> = {};
  for (const part of Object.keys(SCHEMA_QUERIES) as Array<keyof typeof SCHEMA_QUERIES>) {
    const keys = KEEP[part].filter((k) => opts.expressions || k !== 'Expression');
    let rows = slim(
      await executeDax(client, datasetId, SCHEMA_QUERIES[part], opts.workspace),
      keys,
    );
    if (!opts.includeHidden) rows = rows.filter((r) => r.IsHidden !== true);
    out[part] = rows;
  }
  return {
    dataset: datasetId.toLowerCase(),
    counts: {
      tables: out.tables.length,
      columns: out.columns.length,
      measures: out.measures.length,
    },
    ...out,
  };
}
