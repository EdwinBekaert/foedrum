---
paths:
  - "**/scripts/check.ts"
  - "**/scripts/check/**"
  - "**/scripts/check-test-layers.ts"
  - "**/scripts/check-test-layers/**"
  - "**/scripts/test-*.ts"
  - "**/scripts/spec-reporter.ts"
  - "**/scripts/refuse-process-starts.ts"
  - "**/scripts/with-checkout-tmp.ts"
  - "**/test/**/check*.test.ts"
  - "**/test/**/test-*.test.ts"
  - "**/test/**/spec-reporter*.test.ts"
  - "**/test/**/refuse-process-starts*.test.ts"
---

# npm run check and npm test

- `npm run check` — typecheck, lint, test, the test-layer guard (`scripts/check-test-layers.ts`: no file under `test/unit/`, `test/property/`, `test/chaos/` or `test/helpers/` imports `node:child_process` or the real process runner, `spawnProcess`, `execProcess` or `streamProcess`; and no file under `test/integration/` or `test/helpers/` can start the real `gh`, each failing with its file and line: a spawn of `gh` whose call gives no `GH_CONFIG_DIR` of its own; a call to `doctorFromCheckout`, `serveFromCheckout` or `cliFromCheckout` with no `exec` in it, or with the real runner as `exec`; a string naming `src/cli/main.ts`, run or imported; the opt-in end-to-end serve test is excepted by name, [ADR 0086](../../docs/adr/0086-the-test-layer-guard-refuses-integration-tests-that-can-start-the-real-gh.md)) and the offline dependency guard in one command (`scripts/check.ts` first compares `node_modules` with `package-lock.json` in its own checkout, the same check as the gate, and when they differ fails at once with the gate's line, `node_modules is out of date with package-lock.json (<why>); run npm ci`, so a new worktree without `npm ci` says so instead of running against the main checkout's packages; then it starts them together and prints each step's output in order, with the failed steps last so the gate's shortened message still shows them, then names the steps that failed; a step still running after 300 s, or when the check is stopped, is killed with every process it started and fails as timed out or stopped; a step whose output passes 4 MiB is killed the same way, ADR 0035); run it before every push
- `npm test` fails below the coverage thresholds set in the `test` script in `package.json`, which you only ever raise, and, in CI, when one file in `test/unit/` uses more than 5 s of CPU time, per `scripts/test-budget-reporter.ts`; files in `test/property/` and `test/chaos/` get a 15 s ceiling instead, because their run count sets their time. CPU time, not wall time, so queueing behind other sessions does not count ([ADR 0036](../../docs/adr/0036-test-budget-in-cpu-time.md)): each test process reports its own through `scripts/test-cpu-time.ts`, which `npm test` loads with `--import`, and `scripts/spec-reporter.ts` keeps those readings out of spec's output. CPU time still grows with load (the same work took up to seven times as much on a loaded hybrid CPU, #248), so a file over the budget or the ceiling in the run is run again alone after the run, up to three times, starting runs for 90 s at most, and the lowest reading counts; a file within it alone passes with an `ℹ` line naming both readings ([ADR 0089](../../docs/adr/0089-a-file-over-the-test-budget-is-measured-again-alone.md)). The budget and the ceiling fail only in CI (`CI` set and not empty), runs alone included; outside CI a file over its limit is listed in the "test file times" block, fails nothing and is not run alone, since other sessions' load can outlast every run alone ([ADR 0136](../../docs/adr/0136-the-test-budget-fails-only-in-ci.md)). The same preload makes `node:child_process`'s process starts throw in every test process, also through named imports, and fails a file that made one even when the code under test caught the error, so a test that starts a process through any import fails with the ADR 0021 message ([ADR 0038](../../docs/adr/0038-npm-test-processes-refuse-process-starts.md))
