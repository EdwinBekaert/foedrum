# 0038. npm test's processes refuse to start processes

Date: 2026-10-16 · Status: Accepted · Amends [0021](0021-unit-tests-spawn-no-processes.md) and [0036](0036-test-budget-in-cpu-time.md)

## Context
Unit, property and chaos tests start no processes ([0021](0021-unit-tests-spawn-no-processes.md)). Two things enforced that: the test-layer guard (`scripts/check-test-layers.ts`), which sees only a test's direct imports of `node:child_process` or the process runner, and the per-file budget, which caught the time a process cost. Since the budget counts the test process's own CPU time ([0036](0036-test-budget-in-cpu-time.md)), a started process no longer shows in it: the child's time is its own, and waiting costs the test process almost none. A test that starts a process through a module it imports was left to review (#111).

`npm test` already loads one preload, `scripts/test-cpu-time.ts`, in the runner and in every test process it starts.

## Decision
- **The preload refuses process starts in the test processes.** Where `NODE_TEST_CONTEXT` is set (a test process the runner started), `scripts/refuse-process-starts.ts` replaces `spawn`, `spawnSync`, `exec`, `execSync`, `execFile`, `execFileSync` and `fork` on `node:child_process`'s module object with functions that throw an error naming ADR 0021 and `test/integration/`. The runner, where it is not set, keeps starting the test processes.
- **Named imports refuse too.** The default export and `require()` return the module object, so replacing its properties covers them. `import { spawn } from 'node:child_process'` reads the built-in's ES module, which copies the properties when something first imports it; the preload then calls `syncBuiltinESMExports()` from `node:module`, which copies them again. Verified on Node 24.20: without the sync, named, namespace and dynamic imports kept the real functions whenever the ES module existed before the patch; with it, all five forms (named, namespace, default, `require`, dynamic `import()`) refuse in either order.
- **A caught refusal still fails the file.** Code under test may catch the throw: the process runner reports a program that could not start as a result. So each refusal is recorded, and a root `after` hook registered by the preload fails the file when there was one, with the first call's stack, which shows the test and the imports that led to it.
- `npm run test:integration` does not load the preload, so integration tests start processes as before.

## Consequences
- A unit, property or chaos test that starts a process, directly or through any import, fails `npm test`, `npm run check` and the gate, with the ADR 0021 message.
- The test-layer guard stays: it fails fast and offline on the obvious case, and it covers `test/helpers/`. An entry on its exception list no longer lets a test start a process under `npm test`; such a test belongs in `test/integration/`.
- `npm test` patches a built-in module in its test processes. [0021](0021-unit-tests-spawn-no-processes.md) rejected mocking `child_process` to test behaviour; this mocks nothing a test relies on, it only turns a forbidden call into a failure.
- Node's own internals that start a process through `child_process` would be refused too; none does in a test process today, and the full suite passes.
- Starts that bypass `child_process` (native addons, `process.binding`) are not refused; no code in Foedrum uses them.
- An integration test runs fixtures that start a process through an imported module and through the real runner under the preload, and fails when Node changes how built-in ES modules see the patch.

## Alternatives considered
- **Module customization hooks (`module.register`, `module.registerHooks`) that serve a replacement for `node:child_process`:** more machinery (a hooks file, a replacement module that must not import itself), for what replacing the properties of the one module object every route returns already does.
- **Throw only, without the after hook:** simpler, but the process runner swallows the throw and a test that does not check the result passes.
- **Keep it to review:** the gap 0036 named; review misses what it cannot see in the diff, such as a helper that starts using git later.
