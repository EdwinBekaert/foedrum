# 0249. The push gate runs no tests: typecheck, lint and the guards, and CI runs the tests

Date: 2026-10-28 · Status: Accepted · Amends [0045](0045-the-local-gate-reads-commands-as-the-shells-would.md) (what the gate runs before `git push`) and [0241](0241-each-test-runs-at-the-stage-where-it-pays-the-check-runs-the-test-files-a-change-reaches.md) (the push stage runs no tests)

## Context
The local gate runs `npm run check` in the pushed tree before every `git push` and blocks the push when it fails or times out.
Since [ADR 0241](0241-each-test-runs-at-the-stage-where-it-pays-the-check-runs-the-test-files-a-change-reaches.md) the check runs the test files a change reaches, but a change to `scripts/`, `test/helpers/`, `test/fixtures/`, the package files or any non-TypeScript file outside docs (`defaults/`, `schemas/`, `.claude/`, `plugin/`) reaches every test file.
On 2026-10-28 seven sessions ran side by side; five of their branches reached every test file, and the full suite took about 800 s of wall time on the laptop under that load.
Every such check timed out at the test step's 300 s ([ADR 0035](0035-the-process-runner-kills-at-an-output-limit.md)) with no test failing, the gate refused #616's push for that reason alone, and no session could push.
The gate's test run also repeats what CI does minutes later: a session pushes a draft pull request, CI runs every test with coverage on three systems (`npm run check -- --all`), and `gh pr ready` and the merge brief already wait for green CI on the final head.
A red draft costs CI time and nothing else.

## Decision
- `npm run check -- --no-tests` runs every step but the tests: the typecheck, the linter, the test-layer guard and the offline dependency guard.
  Its first line says so: `No tests run here: CI runs them (npm run check -- --all).`
  It does not look for the change, since no test file is chosen.
  `--no-tests` with `--all` is refused.
- The gate runs `npm run check -- --no-tests` before `git push` instead of `npm run check`.
  Nothing else in it changes: the push rules (force, delete, mirror, the denylist, the detached HEAD, the tree a push comes from, `npx`) and `gh pr ready`'s review-summary rule stay as they are.
- The deadlines stay: 300 s per step and 540 s for the gate's check.
  The check without tests took 9 s on the laptop with other sessions running (measured 2026-10-28, its four steps at once); the deadlines guard against a hang, and a lower one would only add the risk of a false block under load.
- A pushed tree whose `scripts/check.ts` does not know `--no-tests` refuses the argument: since #595 (2026-10-27) `checkMode` reads its arguments with `parseArgs`, strict, and an unknown one throws `Unknown option '--no-tests'`, so the check exits 1 before any step.
  The gate then adds one line to the output it shows: the branch's `scripts/check.ts` does not know `--no-tests`, merge `origin/main` and push again.
  A tree older than #595 ignores its arguments and runs the whole check with coverage, as before this decision; merging `origin/main` is the remedy there too.

### Where each test runs
This replaces the first row of [ADR 0241](0241-each-test-runs-at-the-stage-where-it-pays-the-check-runs-the-test-files-a-change-reaches.md)'s stage table; the other rows stay.

| Stage | Runs |
|---|---|
| While coding (`npm run check`) | typecheck, lint, the test-layer and dependency guards, and the test files the change reaches |
| The push gate (`npm run check -- --no-tests`) | typecheck, lint, the test-layer and dependency guards |
| Pull request CI, three systems (`npm run check -- --all`) | everything, with coverage and its thresholds: the merge gate |

## Consequences
- A push no longer depends on how loaded the machine is or how big the suite has grown; it checks in seconds.
- A failing test is found in CI on the draft, not at the push. Sessions still run `npm run check` while coding, and the red and green steps run the test files they change.
- `gh pr ready` and the merge wait for green CI on the final head, as before, so no red head is merged.
- CLAUDE.md's gate lines follow in a docs pull request after this one.

## Alternatives considered
- **The test files a change reaches at the gate, as before:** a change to the shared files reaches every test, and that is what timed out.
- **A longer gate deadline:** the full suite under load took longer than the hook's own 600 s; it would only block later.
- **Slots that queue the checks (#594):** the suite still runs as often, one check after another.
- **Detect an old tree by reading its `scripts/check.ts` before the push:** a second reading of the tree for a case the check's own refusal already reports.
