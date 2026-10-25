// src/config/load.ts
import { ExitCode, ExitWithCode } from '../util/exit-codes';

export interface CliOverrides {
  timeoutMs?: number;
  loginTimeoutMs?: number;
  chromeChannel?: string;
  apiBase?: string;
}

export interface Config {
  httpTimeoutMs: number;
  loginTimeoutMs: number;
  chromeChannel: string;
  apiBase: string;
}

const DEFAULTS: Config = {
  httpTimeoutMs: 60_000,
  loginTimeoutMs: 300_000,
  chromeChannel: 'chrome',
  // Public commercial cloud. Sovereign clouds use other hosts; override with
  // POWERBI_CLI_API_BASE.
  apiBase: 'https://api.powerbi.com',
};

function parseIntStrict(name: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
    throw new ExitWithCode(ExitCode.Config, {
      code: 'config_error',
      message: `Invalid ${name} (must be positive integer): "${raw}"`,
      setting: name,
    });
  }
  return n;
}

/** The bearer goes only to an https Power BI host; anything else is refused. */
export function assertApiBase(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ExitWithCode(ExitCode.Config, {
      code: 'config_error',
      message: `Invalid API base URL: "${raw}"`,
    });
  }
  const h = u.hostname.toLowerCase();
  const ok =
    u.protocol === 'https:' &&
    (h === 'api.powerbi.com' || h.endsWith('.powerbi.com') || h.endsWith('.analysis.windows.net'));
  if (!ok) {
    throw new ExitWithCode(ExitCode.Config, {
      code: 'config_error',
      message: `Refusing to send the bearer to "${raw}": not an https Power BI host`,
    });
  }
  return `${u.protocol}//${u.host}`;
}

export function loadConfig(overrides: CliOverrides = {}): Config {
  const httpEnv = process.env.POWERBI_CLI_HTTP_TIMEOUT_MS;
  const loginEnv = process.env.POWERBI_CLI_LOGIN_TIMEOUT_MS;
  const channelEnv = process.env.POWERBI_CLI_CHROME_CHANNEL;
  const apiEnv = process.env.POWERBI_CLI_API_BASE;

  const httpTimeoutMs =
    overrides.timeoutMs ??
    (httpEnv ? parseIntStrict('POWERBI_CLI_HTTP_TIMEOUT_MS', httpEnv) : DEFAULTS.httpTimeoutMs);
  const loginTimeoutMs =
    overrides.loginTimeoutMs ??
    (loginEnv ? parseIntStrict('POWERBI_CLI_LOGIN_TIMEOUT_MS', loginEnv) : DEFAULTS.loginTimeoutMs);
  const chromeChannel = overrides.chromeChannel ?? channelEnv ?? DEFAULTS.chromeChannel;
  const apiBase = assertApiBase(overrides.apiBase ?? apiEnv ?? DEFAULTS.apiBase);

  return { httpTimeoutMs, loginTimeoutMs, chromeChannel, apiBase };
}
