// src/commands/list.ts
//
// workspaces, reports, datasets: thin reads that keep only the fields an agent
// needs to pick its next call.
import { PowerBiClient } from '../http/client';
import { ExitCode, ExitWithCode } from '../util/exit-codes';

interface Collection<T> {
  value: T[];
}

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Ids go into URL paths, so only a GUID (or "me" for My workspace) is accepted. */
export function assertId(raw: string, what: string, allowMe = false): string {
  if (allowMe && raw === 'me') return raw;
  if (!GUID_RE.test(raw)) {
    throw new ExitWithCode(ExitCode.InvalidInput, {
      code: 'invalid_input',
      message: `${what} must be a GUID${allowMe ? ' or "me"' : ''}, got "${raw}"`,
    });
  }
  return raw.toLowerCase();
}

/** "me" is My workspace, which has no group id in the REST paths. */
export function scope(workspace: string): string {
  return workspace === 'me' ? '/v1.0/myorg' : `/v1.0/myorg/groups/${workspace}`;
}

function pick<T extends object>(row: T, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    const v = (row as Record<string, unknown>)[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

export async function runWorkspaces(client: PowerBiClient) {
  const r = await client.get<Collection<object>>('/v1.0/myorg/groups');
  const rows = r.value.map((w) =>
    pick(w, ['id', 'name', 'type', 'isReadOnly', 'isOnDedicatedCapacity', 'capacityId']),
  );
  return { count: rows.length, workspaces: rows };
}

export async function runReports(client: PowerBiClient, workspace: string) {
  const ws = assertId(workspace, '--workspace', true);
  const r = await client.get<Collection<object>>(`${scope(ws)}/reports`);
  const rows = r.value.map((x) => pick(x, ['id', 'name', 'reportType', 'datasetId', 'webUrl']));
  return { workspace: ws, count: rows.length, reports: rows };
}

export async function runDatasets(client: PowerBiClient, workspace: string) {
  const ws = assertId(workspace, '--workspace', true);
  const r = await client.get<Collection<object>>(`${scope(ws)}/datasets`);
  const rows = r.value.map((x) =>
    pick(x, [
      'id',
      'name',
      'configuredBy',
      'isRefreshable',
      'isEffectiveIdentityRequired',
      'isEffectiveIdentityRolesRequired',
      'targetStorageMode',
      'createdDate',
    ]),
  );
  return { workspace: ws, count: rows.length, datasets: rows };
}
