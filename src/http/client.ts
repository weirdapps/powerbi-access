// src/http/client.ts
import { Agent } from 'undici';

import type { Session } from '../session/store';
import { ExitCode, ExitWithCode } from '../util/exit-codes';
import { PowerBiHttpError, type CallKind } from './errors';

export interface ClientOpts {
  apiBase: string;
  httpTimeoutMs: number;
  connectTimeoutMs?: number;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
const NETWORK_RETRIES = 2;
const RETRYABLE_CODES = new Set([
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EPIPE',
]);

function errorCodeOf(err: unknown): string | undefined {
  const cause = (err as { cause?: unknown })?.cause;
  return (err as { code?: string })?.code ?? (cause as { code?: string } | undefined)?.code;
}

/**
 * A redirect away from the API is never followed: following it would hand the
 * bearer to whatever host the Location names. A sign-in or MCAS landing means
 * the session needs renewing; anything else is the upstream misbehaving.
 */
export function classifyRedirect(location: string | null): ExitWithCode {
  const loc = location ?? '';
  if (/login\.microsoftonline\.com|login\.windows\.net|\.mcas\.ms/i.test(loc)) {
    return new ExitWithCode(ExitCode.AuthRequired, {
      code: 'auth_required',
      message: 'Power BI redirected to sign-in or to the MCAS proxy',
      hint: 'run "powerbi-cli auth-renew", or "powerbi-cli login" if that fails',
    });
  }
  let host = '';
  try {
    host = new URL(loc).hostname;
  } catch {
    /* not a URL */
  }
  return new ExitWithCode(ExitCode.Upstream, {
    code: 'upstream',
    message: `Power BI answered with an unexpected redirect${host ? ` to ${host}` : ''}`,
  });
}

export class PowerBiClient {
  private dispatcher: Agent | undefined;

  constructor(
    private readonly session: Session,
    private readonly opts: ClientOpts,
  ) {
    try {
      this.dispatcher = new Agent({
        connect: { timeout: opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS },
      });
    } catch {
      this.dispatcher = undefined;
    }
  }

  async get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path, undefined, 'generic');
  }

  async post<T>(path: string, body: unknown, kind: CallKind = 'generic'): Promise<T> {
    return this.request<T>('POST', path, body, kind);
  }

  private url(path: string): string {
    if (!path.startsWith('/') || path.startsWith('//')) {
      throw new ExitWithCode(ExitCode.Internal, {
        code: 'internal',
        message: `request path must start with a single "/", got "${path}"`,
      });
    }
    return `${this.opts.apiBase}${path}`;
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    kind: CallKind,
  ): Promise<T> {
    const url = this.url(path);
    let lastErr: unknown;
    for (let attempt = 0; attempt <= NETWORK_RETRIES; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.opts.httpTimeoutMs);
      let resp: Response;
      try {
        resp = await fetch(url, {
          method,
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${this.session.bearerToken}`,
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: ctrl.signal,
          redirect: 'manual',
          ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}),
        } as RequestInit & { dispatcher?: Agent });
      } catch (err) {
        lastErr = err;
        if ((err as Error).name === 'AbortError') {
          throw new ExitWithCode(ExitCode.Upstream, {
            code: 'timeout',
            message: `request timed out after ${this.opts.httpTimeoutMs}ms: ${method} ${path}`,
          });
        }
        const code = errorCodeOf(err);
        if (code === 'UND_ERR_INVALID_ARG' && this.dispatcher) {
          this.dispatcher = undefined;
          attempt--;
          continue;
        }
        if (code && RETRYABLE_CODES.has(code) && attempt < NETWORK_RETRIES) continue;
        throw new ExitWithCode(ExitCode.Upstream, {
          code: 'network',
          message: `network error on ${method} ${path}: ${(err as Error).message}${code ? ` (${code})` : ''}`,
        });
      } finally {
        clearTimeout(timer);
      }

      if (resp.status >= 300 && resp.status < 400) {
        throw classifyRedirect(resp.headers.get('location'));
      }
      const text = await resp.text();
      if (!resp.ok) {
        const requestId = resp.headers.get('requestid') ?? undefined;
        throw new PowerBiHttpError(resp.status, text, kind, requestId);
      }
      if (text.length === 0) return undefined as T;
      // executeQueries prefixes its JSON with a UTF-8 BOM.
      return JSON.parse(text.replace(/^\uFEFF/, '')) as T;
    }
    throw new ExitWithCode(ExitCode.Upstream, {
      code: 'network',
      message: `network error on ${method} ${path}: ${(lastErr as Error)?.message ?? 'unknown'}`,
    });
  }
}
