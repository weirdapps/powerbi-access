# powerbi-access (`powerbi-cli`)

TypeScript CLI for the Power BI REST API, run with your own identity through a
browser-captured bearer. Fourth member of the set alongside
[`outlook-access`](https://github.com/weirdapps/outlook-access) (`outlook-cli`),
[`teams-access`](https://github.com/weirdapps/teams-access) (`teams-cli`) and
[`sharepoint-access`](https://github.com/weirdapps/sharepoint-access)
(`sharepoint-cli`), following the same one-surface-per-repo pattern: its own CLI,
its own `~/.powerbi-cli/` directory, its own Playwright profile, its own login.

Its purpose is to let an agent list workspaces, reports and semantic models,
read a model's schema, and run DAX queries against it, with exactly the
permissions the signed-in user has in the Power BI service.

> **Status: built, unit-tested, not yet verified live.** Every command is
> implemented and covered by tests with synthetic fixtures. The first live login
> needs an interactive sign-in, which has not been completed yet.

## Install

```bash
# HTTPS (no SSH key required):
git clone https://github.com/weirdapps/powerbi-access.git
# or, with SSH:
git clone git@github.com:weirdapps/powerbi-access.git

cd powerbi-access
npm install        # also builds dist/ through the prepare script
node dist/cli.js --help
```

Node 22.19 or newer. Playwright is an optional dependency: only `login` and
`auth-renew` need it, and they drive the locally installed Google Chrome
(`--chrome-channel` to change).

## How authentication works

There is no app registration and no device-code flow. `login` opens Chrome with
a persisted profile (`~/.powerbi-cli/playwright-profile/`), you sign in to the
Power BI web app, and the CLI takes the bearer the web app itself uses for the
Power BI REST API (audience `https://analysis.windows.net/powerbi/api`). It looks
in three places, because which one a tenant exposes varies:

| Source        | Where                                                       |
| ------------- | ----------------------------------------------------------- |
| `wire`        | the `Authorization` header of the app's own API requests    |
| `page-global` | the `powerBIAccessToken` variable the app keeps on `window` |
| `msal-cache`  | an `AccessToken` entry for that audience in MSAL storage    |

It keeps the candidate with the most life left and writes it to
`~/.powerbi-cli/session.json` (mode `0600`, directory `0700`). The token is never
printed; commands report only the account, the source and the expiry.

**MCAS-gated tenants.** With Defender for Cloud Apps session control the web app
is served from `app.powerbi.com.mcas.ms`, a separate origin. The proxy rewrites
hosts, not the `Authorization` header, so the captured token is still a plain
Power BI token. The capture clicks through the MCAS "Redirect Notice" page. On
such a tenant SharePoint issues no bearer at all (that is why `sharepoint-cli` is
cookie-based); Power BI is different because its REST API accepts only bearers.
Whether the tenant also accepts that bearer from outside the browser is what the
first `auth-check` proves.

`auth-renew` repeats the capture headless from the persisted profile. It works
only while the profile holds a persistent Entra sign-in (answer **Yes** to "Stay
signed in?" during `login`; the CLI does this for you) and the device satisfies
the tenant's Conditional Access. It refuses a token with less than 15 minutes
left. A sign-in page during renewal exits 4.

## Commands

| Command                                                   | Purpose                                                                 |
| --------------------------------------------------------- | ----------------------------------------------------------------------- |
| `login`                                                   | Interactive sign-in in Chrome; capture and persist the bearer           |
| `auth-renew`                                              | Headless re-capture from the persisted profile                          |
| `auth-check`                                              | One cheap API read (`GET /groups?$top=1`) proving the bearer works      |
| `workspaces`                                              | Workspaces you can see                                                  |
| `reports --workspace <id\|me>`                            | Reports in a workspace (`me` = My workspace)                            |
| `datasets --workspace <id\|me>`                           | Semantic models in a workspace                                          |
| `schema --dataset <id>`                                   | Tables, columns and measures with descriptions                          |
| `query --dataset <id> --dax <text\|@file> [--max-rows N]` | One DAX query through `executeQueries`, JSON rows out (default cap 500) |

Global options: `--timeout <ms>`, `--login-timeout <ms>`, `--chrome-channel <name>`,
`--api-base <url>`. `schema` and `query` also take `--workspace <id>` to address
the dataset through its workspace. `schema` takes `--include-hidden` and
`--expressions` (adds each measure's DAX).

```bash
CLI="node ~/SourceCode/powerbi-access/dist/cli.js"

$CLI login
$CLI auth-check
$CLI workspaces
$CLI datasets --workspace 00000000-0000-0000-0000-000000000000
$CLI schema --dataset 00000000-0000-0000-0000-000000000000
$CLI query --dataset 00000000-0000-0000-0000-000000000000 --dax 'EVALUATE ROW("x", 1)'
$CLI query --dataset 00000000-0000-0000-0000-000000000000 --dax @top_products.dax --max-rows 50
```

`schema` runs `EVALUATE INFO.VIEW.TABLES()`, `INFO.VIEW.COLUMNS()` and
`INFO.VIEW.MEASURES()`. The `INFO.VIEW` family is readable by anyone allowed to
query the model; the plain `INFO.*` functions need model admin rights.

`query` output:

```json
{
  "dataset": "…",
  "rowCount": 3,
  "returnedRows": 2,
  "truncated": true,
  "columns": ["x"],
  "rows": [{ "x": 1 }, { "x": 2 }]
}
```

A bare `[x]` key becomes `x`; `Table[Column]` keys stay as they are.

## Exit codes

Identical across the four CLIs, so 4 always means "re-authenticate" and 5 always
means "upstream misbehaved".

| Code | Name           | Meaning                                                            |
| ---- | -------------- | ------------------------------------------------------------------ |
| 0    | `Success`      | JSON result on stdout                                              |
| 1    | `Internal`     | Bug or unexpected error                                            |
| 2    | `InvalidInput` | Bad argument, or the model rejected the DAX (`dax_error`)          |
| 3    | `Config`       | Bad setting or environment (`config_error`, `playwright_missing`)  |
| 4    | `AuthRequired` | No session, token expired or refused: `auth-renew`, then `login`   |
| 5    | `Upstream`     | Power BI refused or failed: permissions, not found, throttled, 5xx |
| 6    | `Io`           | Local file problem (e.g. an unreadable `--dax @file`)              |

Errors go to stderr as one JSON line: `code`, `message`, and where known
`status`, `pbiCode` (Power BI's own error code), `requestId` and `hint`.

## What an `executeQueries` failure means

The REST API wraps errors as `{"error":{"code":"…","pbi.error":{…}}}`. The HTTP
status alone is ambiguous, so the CLI reads the code:

| HTTP         | Power BI code                      | CLI `code`                       | Exit | Meaning                                                                 |
| ------------ | ---------------------------------- | -------------------------------- | ---- | ----------------------------------------------------------------------- |
| 401, no body | none                               | `auth_required`                  | 4    | Token missing, malformed or rejected                                    |
| 401/403      | `TokenExpired`                     | `auth_required`                  | 4    | Token expired                                                           |
| 401/403      | `PowerBINotAuthorizedException`    | `execute_queries_not_authorized` | 5    | No Build permission on the dataset, **or** the tenant switch is off     |
| 401/403      | body names the tenant setting      | `execute_queries_disabled`       | 5    | The "Dataset Execute Queries REST API" tenant setting is off            |
| 400          | `DatasetExecuteQueriesError`       | `dax_error`                      | 2    | DAX syntax or semantic error. The API is on and you may query the model |
| 404          | `PowerBIEntityNotFound`            | `not_found`                      | 5    | No Build permission on a dataset you can list (seen live), or a wrong id |
| 429          | any                                | `throttled`                      | 5    | Rate limited                                                            |
| 3xx          | redirect to sign-in or `*.mcas.ms` | `auth_required`                  | 4    | Session no longer accepted (redirects are never followed)               |

**The ambiguous row.** Power BI returns `PowerBINotAuthorizedException` both
when you lack Build permission (Read lets you open reports, not query the model)
and when the tenant has the Execute Queries API switched off, and it does not
say which. Microsoft documents no separate code for the tenant switch; the
`execute_queries_disabled` row fires only if the response text names it. To
tell the two apart, query a dataset you certainly have Build on (one you own in
My workspace, or one where Build was just granted): success there means the
first cause, the same error means the second. A `dax_error` is good news: it
proves both the API and your permission.

## Configuration

| Variable                       | Default                       | Purpose                          |
| ------------------------------ | ----------------------------- | -------------------------------- |
| `POWERBI_CLI_HTTP_TIMEOUT_MS`  | `60000`                       | Per-request timeout              |
| `POWERBI_CLI_LOGIN_TIMEOUT_MS` | `300000`                      | Max wait for interactive login   |
| `POWERBI_CLI_CHROME_CHANNEL`   | `chrome`                      | Playwright browser channel       |
| `POWERBI_CLI_API_BASE`         | `https://api.powerbi.com`     | REST API host (sovereign clouds) |
| `POWERBI_CLI_SESSION_FILE`     | `~/.powerbi-cli/session.json` | Session file location            |

The bearer is sent only to an `https` host under `powerbi.com` or
`analysis.windows.net`; any other `--api-base` is refused.

## Runtime files

| Path                                 | Contents                                 |
| ------------------------------------ | ---------------------------------------- |
| `~/.powerbi-cli/session.json`        | The bearer and its claims (`0600`)       |
| `~/.powerbi-cli/playwright-profile/` | Chrome profile holding the Entra sign-in |
| `~/.powerbi-cli/.browser.lock`       | Stops `login` and `auth-renew` colliding |

## Development

```bash
npm run build   # tsc
npm test        # vitest, synthetic fixtures only
npm run lint    # eslint
bash scripts/pii-gauntlet.sh
```

Layout: `src/auth` (browser capture, token selection, lock), `src/session`
(session file, JWT decode), `src/http` (client, error classification),
`src/commands`, `src/output`, `src/config`, `src/util/exit-codes.ts`.

## License

MIT
