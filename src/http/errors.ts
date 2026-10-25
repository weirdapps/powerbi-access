// src/http/errors.ts
//
// One place decides what a Power BI error means. The REST API wraps most
// failures as {"error":{"code":"...","pbi.error":{"code":"...","details":[...]}}},
// and the same HTTP status means different things depending on that code, so
// the status alone is never enough to choose an exit code.
import { ExitCode, ExitWithCode, type ExitCodeValue } from '../util/exit-codes';
import { redactBody } from '../util/redact';

/** Which call failed. Only executeQueries has its own reading of a 401/403. */
export type CallKind = 'executeQueries' | 'generic';

export interface ParsedPbiError {
  code?: string;
  message?: string;
  detail?: string;
}

const DETAIL_MAX = 1000;

/** Pull code, message and the first detail value out of a Power BI error body. */
export function parsePbiError(body: string): ParsedPbiError {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return {};
  }
  const err = (json as { error?: Record<string, unknown> })?.error;
  if (!err || typeof err !== 'object') return {};
  const pbi = err['pbi.error'] as
    { code?: unknown; details?: Array<{ detail?: { value?: unknown } }> } | undefined;
  const code =
    (typeof err.code === 'string' ? err.code : undefined) ??
    (typeof pbi?.code === 'string' ? pbi.code : undefined);
  const message = typeof err.message === 'string' ? err.message : undefined;
  const first = pbi?.details?.find((d) => typeof d?.detail?.value === 'string');
  const detail =
    typeof first?.detail?.value === 'string' ? first.detail.value.slice(0, DETAIL_MAX) : undefined;
  return { code, message, detail };
}

export interface Classified {
  exit: ExitCodeValue;
  code: string;
  message: string;
  hint?: string;
}

const NOT_AUTHORIZED = 'PowerBINotAuthorizedException';

// Read only for wording that names the tenant switch itself. Microsoft does not
// document a distinct code for "Execute Queries API disabled"; if the tenant
// ever sends one, this is where it is recognised. Unmatched, the 401 stays
// classified as ambiguous below, which is the honest answer.
const TENANT_SWITCH_RE = /tenant setting|disabled by (your )?(tenant )?admin|FeatureNotAvailable/i;

export function classify(
  status: number,
  body: string,
  kind: CallKind,
  requestId?: string,
): Classified {
  const p = parsePbiError(body);
  const where = requestId ? ` [req=${requestId}]` : '';

  if (p.code === 'TokenExpired' || (status === 401 && !p.code)) {
    return {
      exit: ExitCode.AuthRequired,
      code: 'auth_required',
      message: `Power BI rejected the cached token (HTTP ${status}${p.code ? ` ${p.code}` : ''})${where}`,
      hint: 'run "powerbi-cli auth-renew", or "powerbi-cli login" if that fails',
    };
  }

  if (kind === 'executeQueries') {
    if (status === 400 && p.code === 'DatasetExecuteQueriesError') {
      return {
        exit: ExitCode.InvalidInput,
        code: 'dax_error',
        message:
          `The model rejected the DAX query${p.detail ? `: ${p.detail}` : ''}${where}. ` +
          'Reaching this error means the Execute Queries API is enabled and you are allowed to query this dataset.',
      };
    }
    if ((status === 401 || status === 403) && TENANT_SWITCH_RE.test(body)) {
      return {
        exit: ExitCode.Upstream,
        code: 'execute_queries_disabled',
        message: `The tenant has the "Dataset Execute Queries REST API" setting switched off for you (HTTP ${status} ${p.code ?? ''})${where}.`,
        hint: 'only a Fabric administrator can change this; Build permission alone will not help',
      };
    }
    if ((status === 401 || status === 403) && p.code === NOT_AUTHORIZED) {
      return {
        exit: ExitCode.Upstream,
        code: 'execute_queries_not_authorized',
        message:
          `HTTP ${status} ${NOT_AUTHORIZED} on executeQueries${where}. Power BI returns this ` +
          'same code for two different causes and does not say which: (a) you lack Build ' +
          'permission on this dataset (Read alone lets you open reports, not query the model), ' +
          'or (b) the tenant setting "Dataset Execute Queries REST API" is off. Your token itself ' +
          'is fine, so re-authenticating will not help.',
        hint:
          'Tell them apart by querying a dataset you certainly have Build on (one you own in My ' +
          'workspace, or one where Build was just granted). Success there means (a); the same ' +
          'error there means (b).',
      };
    }
  }

  if (status === 404 || p.code === 'PowerBIEntityNotFound' || p.code === 'ItemNotFound') {
    return {
      exit: ExitCode.Upstream,
      code: 'not_found',
      message: `Not found, or not visible to you (HTTP ${status} ${p.code ?? ''})${where}`,
      // Observed live: executeQueries answers 404, not 401, on a dataset the caller can list
      // with Read but holds no Build on.
      ...(kind === 'executeQueries'
        ? {
            hint:
              'If `datasets` lists this id, you have Read but no Build permission on it: ask the ' +
              'workspace owner for Build. Otherwise check the dataset id.',
          }
        : {}),
    };
  }
  if (status === 401 || status === 403) {
    return {
      exit: ExitCode.Upstream,
      code: 'access_denied',
      message: `Access denied (HTTP ${status} ${p.code ?? ''})${where}: your token is valid but this item or API is not open to you`,
    };
  }
  if (status === 429) {
    return {
      exit: ExitCode.Upstream,
      code: 'throttled',
      message: `Power BI throttled the request (HTTP 429)${where}; retry later`,
    };
  }
  if (status === 400) {
    return {
      exit: ExitCode.InvalidInput,
      code: 'bad_request',
      message: `Power BI refused the request (HTTP 400 ${p.code ?? ''})${p.detail ? `: ${p.detail}` : ''}${where}`,
    };
  }
  return {
    exit: ExitCode.Upstream,
    code: 'upstream',
    message: `Power BI answered HTTP ${status} ${p.code ?? ''}: ${redactBody(p.message ?? body)}${where}`,
  };
}

export class PowerBiHttpError extends Error {
  public readonly classified: Classified;
  constructor(
    public readonly status: number,
    body: string,
    kind: CallKind,
    public readonly requestId?: string,
  ) {
    const c = classify(status, body, kind, requestId);
    super(c.message);
    this.name = 'PowerBiHttpError';
    this.classified = c;
    this.pbiCode = parsePbiError(body).code;
  }
  public readonly pbiCode?: string;

  toExit(): ExitWithCode {
    const c = this.classified;
    return new ExitWithCode(c.exit, {
      code: c.code,
      message: c.message,
      status: this.status,
      ...(this.pbiCode ? { pbiCode: this.pbiCode } : {}),
      ...(this.requestId ? { requestId: this.requestId } : {}),
      ...(c.hint ? { hint: c.hint } : {}),
    });
  }
}
