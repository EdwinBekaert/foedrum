# 0362. The canned gh answers take their runner, and the CLI tests that start nothing are unit tests

Date: 2026-11-10 · Status: Accepted · Amends [0073](0073-github-only-through-gh-s-own-login.md) (where `cannedGhLogin` lives, and that it has no default runner) and [0086](0086-the-test-layer-guard-refuses-integration-tests-that-can-start-the-real-gh.md) (where the tests of `cliFromCheckout`'s injected runner are)

## Context
`cannedGhLogin` answers gh from captured output and hands every other tool to a runner, the real `execProcess` by default ([ADR 0073](0073-github-only-through-gh-s-own-login.md)).
That default kept it in `test/integration/canned-gh-login.ts`, since `test/helpers/` may not import the real runner ([ADR 0021](0021-unit-tests-spawn-no-processes.md)), and so it kept the CLI tests that use it in `test/integration/cli.test.ts`, also the tests that start no process.
The audit of the integration suite (#869) found that 17 of that file's 18 tests pass with process starts refused.
The 18th lists a kept branch from a real clone: `cli-main.ts` runs git with no seam (ADR 0092).

## Decision
- **The canned gh answers live in `test/helpers/canned-gh.ts`**: `cannedGhLogin(exec)` and `doctorHere(cwd, exec, resolve?)` take the runner they wrap, with no default.
  An integration test passes `execProcess`; a unit test passes a runner that starts nothing.
  The helper imports no real runner, as the test-layer guard requires of `test/helpers/`.
- **The CLI tests that start no process are unit tests**, in `test/unit/cli-main.test.ts`, through `cliFromCheckout` against real store and recipe files, with the canned gh over a runner that starts nothing and a made-up PATH lookup.
  Among them are the tests that `cliFromCheckout` asks doctor's and serve's gh through the runner it is given ([ADR 0086](0086-the-test-layer-guard-refuses-integration-tests-that-can-start-the-real-gh.md)'s Tests bullet).
- `test/integration/cli.test.ts` keeps the kept-branch test, which needs git.

## Consequences
- The guard's own rule on `test/integration/` and `test/helpers/` is unchanged: a call of `cliFromCheckout`, `doctorFromCheckout` or `serveFromCheckout` still needs an injected runner, and its message names `cannedGhLogin(execProcess)`.
- `npm test`'s preload, which refuses every process start (ADR 0038), now holds the moved tests to starting none.
