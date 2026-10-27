# 0241. Each test runs at the stage where it pays: the check runs the test files a change reaches

Date: 2026-10-27 · Status: Accepted · Amends [0134](0134-the-red-proof-runs-once-the-review-drops-its-coverage-delta-and-property-and-chaos-run-on-one-leg-per-pull-request.md) (where the tests run: the stage table below; its legs and run counts stay)

## Context
`npm run check` ran the typecheck, the linter, all 7,755 unit, property and chaos tests with coverage, the test-layer guard and the dependency guard.
It runs while coding, before every push (the push gate, `scripts/precheck.ts`), several times in each session, and in CI on three systems.
The same check on one pull request (#582), measured 2026-10-27:

| Where | Whole check | Slowest file (`test/chaos/shrink.test.ts`) |
|---|---|---|
| CI, Linux (4 cores) | 63 s | 6.5 s CPU |
| CI, macOS | 74 s | 4.7 s CPU |
| CI, Windows | 83 s | 7.9 s CPU |
| A Windows laptop, quiet | about 170 s | 20 s CPU, 86 s wall |
| The same laptop, five worktrees checking | over 300 s: the step timed out | 208 s wall |

A pull request runs the full suite about six to ten times on the developer's machine (own checks, the gate per push and its retries, review rounds), and CI, the gate a merge waits for, runs it once more.
Five earlier fixes (#87, #108, #140, #248, #363) changed how a file's time is measured; none changed how often the suite runs.
With several sessions checking at once, the test step passes its 300 s deadline ([ADR 0035](0035-the-process-runner-kills-at-an-output-limit.md)) and the push is blocked, though the change touched one file.

Other tools run only the tests a change reaches, and the full suite at a later stage: `jest --findRelatedTests` and `vitest --changed` follow the import graph from changed files to test files; Nx and Bazel build and test only the targets a change affects; Google runs a change's affected tests in presubmit and everything in postsubmit.

## Decision

### Where each test runs
| Stage | Runs |
|---|---|
| While coding and at the push gate (`npm run check`) | typecheck, lint, the test-layer and dependency guards, and the test files the change reaches |
| Pull request CI, three systems (`npm run check -- --all`) | everything, with coverage and its thresholds: the merge gate |
| Nightly | chaos and property at their full run count (#596) |
| Brett | only the tests that cover a mutated line (#597) |

### What a change is
- The files that differ between the merge base of `HEAD` with `origin/main` and the working tree, untracked files included (`git diff --name-only --no-renames <base>` and `git ls-files --others --exclude-standard`), so a check while coding and the gate on a clean tree see the same set.
- A rename counts as its old and its new path.
- No `origin/main`, no merge base, or a git call that fails: every test file runs, with a line that says why.

### What a test file reaches
- A test file under `test/{unit,property,chaos}/` reaches a changed file when a chain of relative imports leads from it to that file, read as text with no dependency and no type checker: `import … from '<path>'`, `export … from '<path>'`, `import '<path>'` and `import('<literal path>')`.
  The reading may find too many imports (a `from './x.ts'` inside a string), never too few for these forms.
- A changed test file reaches itself.
- A change to `package.json`, `package-lock.json`, `tsconfig.json`, `scripts/` or `test/helpers/` reaches every test file: they set how every test runs.
- A change only to docs (`docs/`, a top-level `*.md`) reaches none.
- Any other changed file that is not TypeScript (`test/fixtures/`, `defaults/`, `schemas/`, `plugin/`, `biome.json`, `.claude/`, `.github/`) reaches every test file, since tests read such files by path: simpler than matching paths in test text, and never too few.
- A deleted file reaches the files that still import its path, and a file that stopped importing it is itself changed; a renamed file is a deleted and an added one.

### How the check runs them
- `npm run check` runs the files the change reaches with the same test command as `npm test`, through `scripts/with-checkout-tmp.ts`, with the CPU-time preload and both reporters, without coverage, and names the files it ran before the steps' output.
  The check starts node with that command and the files itself (`TEST_COMMAND` in `scripts/check.ts`, which a unit test holds `package.json`'s `test` script to), not through an npm script: npm runs a script through cmd.exe on Windows, whose command line ends at 8,191 characters, and the 239 test files' paths alone take about 7,600; node started without a shell gets Windows' 32,767.
  With no file reached it runs no test step and says "no test file reached".
  When every file is reached it runs them all, still without coverage.
- `npm run check -- --all` runs every test file with coverage and its thresholds, exactly `npm test`; a part of the suite cannot meet the thresholds.
- `npm test` stays the command a contributor types for every test file with coverage.
- **The re-measure matches the run**: a file run again alone ([ADR 0089](0089-a-file-over-the-test-budget-is-measured-again-alone.md)) gets coverage only when its run had it, read from the test runner's own flags, so a reading without coverage is not measured again with it.

### What stays
- The push gate runs `npm run check` as before, so it gets the affected set; the 300 s step deadline and the gate's 540 s check deadline stay as the guard against a hang.
- CI runs `npm run check -- --all` on every leg, otherwise unchanged.
- Where the per-file budget fails is [ADR 0136](0136-the-test-budget-fails-only-in-ci.md)'s, amended by #596.

## Consequences
- A change to one CLI file checks in seconds: its own tests and those whose imports reach it.
- A change to `scripts/`, `test/helpers/`, the package files or any non-TypeScript file outside docs still runs every test file locally, without coverage.
- A test that reaches a changed file by another path than a relative import (a computed `import()`, a file read by path from TypeScript under `src/`, a subprocess) is not run locally; CI runs it before the merge. That is the risk this accepts: a break found in CI instead of at the push.
- Coverage below the thresholds fails in CI and in `npm run check -- --all`, no longer at the push.

## Alternatives considered
- **Slots that queue the checks (#594):** the full suite still runs as often, only one after another; the queue grows with every session.
- **A longer step timeout:** it hides a hang for longer and does not make a check cheaper.
- **The full suite at the gate:** CI already runs it, and a merge waits for `ci-ok`.
- **A type checker or a bundler to find imports:** exact, but a dependency or a slow start for a reading that may err only towards too many.
- **A second npm script that takes the files (`npm run test:files -- <files>`):** one place for the command, but the file list would pass through cmd.exe's 8,191-character command line on Windows.
- **Matching fixture paths in test text:** fewer files for a fixture change, but a path built at run time would be missed; every file is never too few.
