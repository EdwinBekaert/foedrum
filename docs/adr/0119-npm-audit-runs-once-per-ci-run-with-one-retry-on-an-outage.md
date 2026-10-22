# 0119. npm audit runs once per CI run, with one retry on an outage

Date: 2026-10-22 · Status: Accepted · Amends [0004](0004-built-in-first-dependency-policy.md) (where and how CI runs `npm audit`)

## Context
[ADR 0004](0004-built-in-first-dependency-policy.md) put `npm audit` in CI, and CI ran `npm audit --omit=dev` on all six legs of its matrix ([ADR 0010](0010-cross-platform-and-isolation-levels.md)). The audit sends the lockfile's runtime packages to npm's advisory endpoint (`POST /-/npm/v1/security/advisories/bulk`), and the answer depends on the lockfile alone, not on the platform or the Node version: six calls ask the same question. `npm audit signatures` is different: it checks the packages installed on that leg.

On 2026-10-22 the endpoint answered `503 Service Unavailable` after a five-minute wait. It failed both Ubuntu legs of #322 and one macOS leg of #323, and each needed a rerun (#330). Every extra leg is another chance to hit an outage, and none adds information.

npm's exit code does not tell an outage from a finding. Its documentation says `npm audit` exits 0 when no vulnerabilities were found and otherwise as `audit-level` sets it ([npm audit](https://docs.npmjs.com/cli/commands/npm-audit), "Exit Code"); it does not say what happens when the endpoint fails. In npm 11.19.0 (`lib/utils/audit-error.js`), a failed request makes npm print, with `--json`, an object with the request's `message`, `method`, `uri`, `headers`, `statusCode` and `body` (only `message` when no answer came), then throw `audit endpoint returned an error`: exit 1, as for a finding. A report has `auditReportVersion` and `vulnerabilities` instead. The documentation also describes a fallback to a Quick Audit endpoint; 11.19.0's arborist (`audit-report.js`) asks only the bulk endpoint.

## Decision
- **Once per run.** `npm audit --omit=dev` runs in an `audit` job of its own on `ubuntu-latest` with Node 24, which `ci-ok` needs next to the matrix. It needs no `npm ci`: npm audit reads `package-lock.json` when `node_modules` is missing. `npm audit signatures` stays on every leg.
- **One retry on an outage.** The job runs `npm run audit:advisories` (`scripts/npm-audit.ts`, with its decisions in `scripts/npm-audit/core.ts`, ADR 0021), which runs `npm audit --omit=dev --json` and reads stdout:
  - exit 0 with a report of no vulnerabilities passes;
  - a report with vulnerabilities fails at once and names each package, its severity and advisories;
  - an endpoint error with a 5xx status, or with no status (no answer), is tried again once after 30 s; a second one fails, saying that an outage is not a clean report;
  - an endpoint error with any other status (a 4xx) fails at once, since asking again will not change it;
  - anything else fails at once, also an exit 0 without a clean report, so an outage is never read as "no advisories".

  npm gets 360 s per try, above its own 300 s fetch timeout; a killed npm fails without a retry.
- **Between runs.** An advisory published between two CI runs is reported by Dependabot alerts ([ADR 0113](0113-github-s-security-features-on-the-foedrum-repository.md)), which watch the dependency graph continuously; the nightly run audits again. Six legs did not narrow that gap, since they ran at the same moment.

## Consequences
- One call to the advisory endpoint per run instead of six; a transient outage costs one 30 s wait instead of a rerun.
- An outage that lasts past the retry still fails the run, as it should: `ci-ok` stays red until the audit has really answered.
- The tests read npm 11.19.0's recorded `--json` output (`test/fixtures/npm-audit/`: clean, findings, 503, 404, no answer) and never call the registry. A change in npm's error shape makes the script fail closed (`unreadable`), not pass.

## Alternatives considered
- **Keep six legs and mark the step `continue-on-error`:** an outage would then pass as "no advisories", the failure #330 rules out.
- **Match the `audit endpoint returned an error` line on stderr:** works, but stderr is a log meant for people; the `--json` object carries the status, which separates an outage (retry) from a refused request (fail).
- **Retry in a shell loop in the workflow:** it would read only the exit code, which is the same for findings and an outage, and could not be unit tested.
- **More retries, or longer waits:** the 503 of #330 came after five minutes; a longer outage is for a rerun, not for a job that waits.
