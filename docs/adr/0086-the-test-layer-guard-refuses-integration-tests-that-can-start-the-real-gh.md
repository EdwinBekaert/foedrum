# 0086. The test-layer guard refuses integration tests that can start the real `gh`

Date: 2026-10-18 · Status: Accepted · Amends [0021](0021-unit-tests-spawn-no-processes.md) (what the test-layer guard reads)

## Context
No test of any layer may reach a login, gh's included ([ADR 0075](0075-only-a-lower-bound-reads-the-wall-clock-and-doctor-runs-against-stub-tools.md), #212). An integration test runs real tools, so it can start the real `gh` with whatever login the machine has: by spawning `gh`, by calling `doctorFromCheckout` or `serveFromCheckout` with their defaults, the real runner and PATH, or by running `src/cli/main.ts`, which wires in those defaults. PR #207 took four review rounds because each fix covered only the test that had just failed. The test-design lens and CLAUDE.md state the rule (#213, #216), but nothing checked it.

ADR 0073 still has `gh` run for real in two places, against a local fake GitHub with a login of the test's own: the client tests in `test/integration/github-gh.test.ts`, through `fake-github-over-gh.ts`, whose `gh auth login` writes into a `GH_CONFIG_DIR` the test made; and the opt-in end-to-end serve test, which runs `src/cli/main.ts` as the real program with that environment.

## Decision
- **`scripts/check-test-layers.ts` also reads every source file under `test/integration/` and `test/helpers/`** and fails, with the file and the line, on:
  - **a spawn of `gh`**: a call whose first argument is the string `gh` (also `gh.exe`, `gh.cmd`) to `spawn`, `spawnSync`, `exec`, `execSync`, `execFile`, `execFileSync`, `execProcess`, `spawnProcess` or `streamProcess`, or to anything with an argument array after it (a runner made with `execProcessWith`); and a command line that starts with `gh ` given to one of those functions. A call that names `GH_CONFIG_DIR` within its own parentheses passes: gh then reads a configuration the test chose, not the machine's;
  - **`doctorFromCheckout`, `serveFromCheckout` or `cliFromCheckout` without an injected runner**: a call whose parentheses hold no `exec` key or shorthand property;
  - **`src/cli/main.ts` run or imported**: a string `main.ts`, or one that ends in `cli/main.ts`.
- **It reads code, not comments or string contents.** Comments, and the contents of strings, templates and regular expressions, are blanked before the calls are matched (a template's `${…}` stays code), so a call named in a comment or written inside a string does not count; a string that names `main.ts` does. Like the import check, it errs on the side of failing: an options variable without a visible `exec` fails, and a helper of the test's own that wraps those calls is not followed.
- **`cliFromCheckout` (`src/cli/cli-main.ts`) is the wiring `main.ts` runs**, with `exec` and `resolve` that can be injected, as for doctor and serve. `main.ts` only writes what it returns. The CLI integration tests call it in process with gh answered from captured output (`canned-gh-login.ts`) instead of running the program.
- **One exception, by name:** `REAL_GH_EXCEPTIONS` holds `integration/serve.test.ts`, the opt-in end-to-end serve test (`FOEDRUM_REAL_CLAUDE=1`, ADR 0057), whose real program's `gh` reaches the local fake GitHub with a login of the test's own. An entry whose file has no finding is reported, so the list cannot go stale. The whole file is excused, as for the import check's list; its other test calls `serveFromCheckout` with an injected runner anyway.
- **Tests:** the forms refused and accepted on plain file text, the lines, the exception list and its one entry in `test/unit/check-test-layers.test.ts`; the command naming the file and line of a probe in `test/integration/check-test-layers.test.ts`.

## Consequences
- `npm run check` fails on a new integration test that can start the real `gh`, before review.
- `fake-github-over-gh.ts` names `GH_CONFIG_DIR` in its `gh auth login` call, although its environment already set it.
- A test that needs `foedrum <command>` end to end calls `cliFromCheckout` with an injected runner; only the opt-in serve test runs the program.
- The guard reads text. `gh` started under another name, through a variable holding its path, or by code under `src/` that a test calls without one of the three functions is not caught here; review and the test-design lens remain the check for those.

## Alternatives considered
- **Refuse every spawn of `gh`, with `fake-github-over-gh.ts` on the exception list.** The client tests are ADR 0073's tool boundary and reach no machine login; an exception for a helper would excuse every future spawn in it. Naming the configuration in the call is the same kind of injection as a runner, and checkable.
- **Make `exec` required in `doctorFromCheckout` and `serveFromCheckout`, so the type checker refuses the defaults.** It would not catch a spawn of `gh` or `main.ts` run as a program, and the issue asks for the guard, with file and line.
