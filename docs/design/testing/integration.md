# Integration tests

Integration tests (`test/integration/`, `npm run test:integration`, CI and nightly) are a few per tool boundary.
They run the real git, npm or shell to prove the thin shells and the captured fixtures still match the real tools.

They test Foedrum's code against a tool, never whether the tool itself works:
- the real `gh` runs only against a local fake GitHub, never github.com ([ADR 0073](../../adr/0073-github-only-through-gh-s-own-login.md));
- the tests against the real `claude` run only with `FOEDRUM_REAL_CLAUDE=1` ([ADR 0057](../../adr/0057-real-claude-tests-are-opt-in-and-claude-proofs-leave-the-suite.md)).

CI's `real-claude` job sets it with a `claude` pinned in `ci/claude/` ([ADR 0399](../../adr/0399-ci-runs-the-tests-against-the-installed-claude-with-a-claude-pinned-in-a-lockfile-of-its-own.md), [ADR 0407](../../adr/0407-a-pull-request-asks-for-one-macos-job.md)):
- in the nightly run, every such test on every leg;
- on a push to `main`, every such test on macOS only;
- on a pull request, the ones its change reaches, on Linux and Windows only (`scripts/affected-tests.ts --real-claude`).

`npm run check` refuses an integration test that can start the real `gh` ([ADR 0086](../../adr/0086-the-test-layer-guard-refuses-integration-tests-that-can-start-the-real-gh.md), [ADR 0362](../../adr/0362-the-canned-gh-answers-take-their-runner-and-the-cli-tests-that-start-nothing-are-unit-tests.md)):
- `cliFromCheckout`, `doctorFromCheckout` and `serveFromCheckout` take the runner they start gh through;
- in an integration test, that is `cannedGhLogin(execProcess)` from `test/helpers/canned-gh.ts`;
- the CLI tests that start no process are unit tests, with `cannedGhLogin` over a runner that starts nothing.

To run one file, as a change to the code it covers asks:

```
node scripts/with-checkout-tmp.ts --import ./scripts/lower-priority.ts --test test/integration/flight-orders.test.ts
```
