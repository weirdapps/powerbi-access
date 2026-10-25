#!/usr/bin/env node
// src/cli.ts
import { Command } from 'commander';

import { loadConfig, type CliOverrides, type Config } from './config/load';
import { PowerBiClient } from './http/client';
import { emit, emitError, toExit } from './output/json';
import { ExitCode, ExitWithCode } from './util/exit-codes';
import { requireSession } from './commands/session';
import { runLogin, runAuthRenew } from './commands/login';
import { runAuthCheck } from './commands/auth-check';
import { runWorkspaces, runReports, runDatasets } from './commands/list';
import { runQuery, DEFAULT_MAX_ROWS } from './commands/query';
import { runSchema } from './commands/schema';

const VERSION = '0.1.0';

interface GlobalOpts {
  timeout?: string;
  loginTimeout?: string;
  chromeChannel?: string;
  apiBase?: string;
}

export function parseIntOption(raw: string, flag: string): number {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0 || String(n) !== raw.trim()) {
    throw new ExitWithCode(ExitCode.InvalidInput, {
      code: 'invalid_input',
      message: `${flag} must be a positive integer, got "${raw}"`,
    });
  }
  return n;
}

function configFrom(program: Command): Config {
  const g = program.opts<GlobalOpts>();
  const o: CliOverrides = {};
  if (g.timeout) o.timeoutMs = parseIntOption(g.timeout, '--timeout');
  if (g.loginTimeout) o.loginTimeoutMs = parseIntOption(g.loginTimeout, '--login-timeout');
  if (g.chromeChannel) o.chromeChannel = g.chromeChannel;
  if (g.apiBase) o.apiBase = g.apiBase;
  return loadConfig(o);
}

function clientFrom(program: Command) {
  const config = configFrom(program);
  const session = requireSession();
  return {
    session,
    client: new PowerBiClient(session, {
      apiBase: config.apiBase,
      httpTimeoutMs: config.httpTimeoutMs,
    }),
  };
}

async function run(fn: () => Promise<unknown>): Promise<void> {
  try {
    emit(await fn());
    process.exitCode = ExitCode.Success;
  } catch (err) {
    const { code, payload } = toExit(err);
    emitError(payload);
    process.exitCode = code;
  }
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name('powerbi-cli')
    .description('CLI for the Power BI REST API via a browser-captured bearer')
    .version(VERSION)
    .option('--timeout <ms>', 'per-request HTTP timeout')
    .option('--login-timeout <ms>', 'max wait for interactive sign-in')
    .option('--chrome-channel <name>', 'Playwright Chrome channel')
    .option('--api-base <url>', 'Power BI REST API base URL (default https://api.powerbi.com)');

  program
    .command('login')
    .description('Interactive sign-in in Chrome; captures and persists the Power BI bearer')
    .action(() => run(() => runLogin(configFrom(program))));

  program
    .command('auth-renew')
    .description('Headless silent re-capture from the persisted browser profile')
    .action(() => run(() => runAuthRenew(configFrom(program))));

  program
    .command('auth-check')
    .description('Prove the cached bearer works with one cheap API read')
    .action(() =>
      run(async () => {
        const { client, session } = clientFrom(program);
        return runAuthCheck(client, session);
      }),
    );

  program
    .command('workspaces')
    .description('List the workspaces you can see')
    .action(() => run(() => runWorkspaces(clientFrom(program).client)));

  program
    .command('reports')
    .description('List the reports in a workspace')
    .requiredOption('--workspace <id>', 'workspace GUID, or "me" for My workspace')
    .action((o: { workspace: string }) =>
      run(() => runReports(clientFrom(program).client, o.workspace)),
    );

  program
    .command('datasets')
    .description('List the semantic models (datasets) in a workspace')
    .requiredOption('--workspace <id>', 'workspace GUID, or "me" for My workspace')
    .action((o: { workspace: string }) =>
      run(() => runDatasets(clientFrom(program).client, o.workspace)),
    );

  program
    .command('schema')
    .description('Tables, columns and measures with descriptions (DAX INFO.VIEW functions)')
    .requiredOption('--dataset <id>', 'dataset GUID')
    .option('--workspace <id>', 'workspace GUID, to address the dataset through its workspace')
    .option('--include-hidden', 'include hidden tables, columns and measures')
    .option('--expressions', "include each measure's DAX expression")
    .action(
      (o: {
        dataset: string;
        workspace?: string;
        includeHidden?: boolean;
        expressions?: boolean;
      }) =>
        run(() =>
          runSchema(clientFrom(program).client, o.dataset, {
            workspace: o.workspace,
            includeHidden: o.includeHidden,
            expressions: o.expressions,
          }),
        ),
    );

  program
    .command('query')
    .description('Run one DAX query (executeQueries); JSON rows out')
    .requiredOption('--dataset <id>', 'dataset GUID')
    .requiredOption('--dax <text>', 'the DAX query, or @path to read it from a file')
    .option('--max-rows <n>', `rows to print (default ${DEFAULT_MAX_ROWS})`)
    .option('--workspace <id>', 'workspace GUID, to address the dataset through its workspace')
    .action((o: { dataset: string; dax: string; maxRows?: string; workspace?: string }) =>
      run(() =>
        runQuery(clientFrom(program).client, {
          dataset: o.dataset,
          dax: o.dax,
          maxRows: o.maxRows ? parseIntOption(o.maxRows, '--max-rows') : undefined,
          workspace: o.workspace,
        }),
      ),
    );

  return program;
}

if (require.main === module) {
  buildProgram()
    .parseAsync(process.argv)
    .catch((err) => {
      const { code, payload } = toExit(err);
      emitError(payload);
      process.exitCode = code;
    });
}
