# powerbi-access

`powerbi-cli`: Power BI REST API access with the user's own identity, through a
bearer captured from the Power BI web app by Playwright. Same layout and exit
codes as the sibling `outlook-access`, `teams-access` and `sharepoint-access`.

- Build, test, lint: `npm run build`, `npm test`, `npm run lint`. Tests use
  synthetic fixtures only (`test_scripts/helpers.ts`); never add a captured
  response, a real id or a real name.
- Public repo: run `bash scripts/pii-gauntlet.sh` before every commit. Remove
  sensitive content rather than disguise it.
- Never print or log a token. `session.json` is `0600` under `~/.powerbi-cli/`.
- Error meaning lives in one place: `src/http/errors.ts` (`classify`). Add a new
  Power BI error code there, with a test, and document it in the README table.
