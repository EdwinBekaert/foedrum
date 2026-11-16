# Testing strategy

Stability is proven, not claimed.

| Page | What it covers |
|---|---|
| [Unit tests](unit.md) | No processes, the CPU-time budget |
| [Integration tests](integration.md) | A few per tool boundary |
| [Fake brewer runner](fake-runner.md) | Scripted brewer behaviours |
| [Property tests](property.md) | Invariants I1–I6 on generated scenarios |
| [Chaos tests](chaos.md) | The real driver, killed at random points |
| [End-to-end tests](end-to-end.md) | Nip through serve, end to end; browser tests not yet |

No test of any layer holds the wall clock to a limit, since load from other sessions stretches it (only a lower bound may read it, [ADR 0075](../../adr/0075-only-a-lower-bound-reads-the-wall-clock-and-doctor-runs-against-stub-tools.md)): deadlines and timers are injected and driven by the test, "at once" is proven by an order of events, a wait for an end is only guarded against a hang, and a performance property is measured in CPU time ([ADR 0070](../../adr/0070-tests-never-hold-the-wall-clock-to-a-limit.md)).

## Which tests run when

Each test runs at the stage where it pays ([ADR 0241](../../adr/0241-each-test-runs-at-the-stage-where-it-pays-the-check-runs-the-test-files-a-change-reaches.md)).

| Stage | What runs | Where it is set |
|---|---|---|
| While writing | A red or green step runs the test files it changes with `node --test`; `npm run check` runs the typecheck, the lint, the guards and the unit, property and chaos test files the change reaches, without coverage | `scripts/check.ts`, `scripts/affected-tests.ts` |
| The push gate | Before a `git push` in a Claude Code session: `npm run check -- --no-tests`, every step but the tests ([ADR 0249](../../adr/0249-the-push-gate-runs-no-tests.md)) | `.claude/settings.json`, `scripts/precheck.ts` |
| A pull request | On Linux, Windows and macOS: `npm run check -- --all` (every unit, property and chaos file, with coverage and its thresholds), `npm run test:integration` and `npm audit signatures`. On Linux only: the dependency guard with publish dates, the property tests with 500 seeds and the chaos tests with 200 runs. On Linux and Windows: the tests against the installed `claude` that the change reaches, and the package built, installed and started. Once: `npm audit --omit=dev` and the CLA check. A pull request that changes `release.yml` or `package.yml` also runs the release as a dry run | `.github/workflows/ci.yml`, `package.yml`, `release.yml` |
| A push to `main` | The same platform checks, extra seeds, dependency guard and audit as a pull request, with no CLA check and no release dry run, the package on all three systems, and every test against the installed `claude` on macOS and none on Linux and Windows ([ADR 0407](../../adr/0407-a-pull-request-asks-for-one-macos-job.md)) | `.github/workflows/ci.yml` |
| The nightly run (03:17 UTC) | As a push to `main`, with the property and chaos tests at 1,000 each on every leg, and every test against the installed `claude` on all three systems | `.github/workflows/ci.yml` |
| A release | A tag `v*` on a merge commit of `main` whose CI run passed: the package built, installed and started on all three systems, then published ([ADR 0388](../../adr/0388-a-tag-on-a-green-main-publishes-through-trusted-publishing-and-a-dry-run-proves-the-rest.md)) | `.github/workflows/release.yml` |

`ci-ok`, the one required check, passes only when the platform checks, the tests against the installed `claude`, the package and the audit passed, and on a pull request the CLA check.

- **Cross-platform:** the unit, property, chaos and integration tests run on Windows, macOS and Linux in every CI run; on a pull request the tests against the installed `claude` and the package leave out macOS, which the push to `main` runs ([ADR 0407](../../adr/0407-a-pull-request-asks-for-one-macos-job.md), [cross-platform rules](../platform/cross-platform.md)).
- **Coverage:** `npm test` fails below 90% of lines, 85% of branches and 90% of functions (its script in `package.json`), and CI runs it on every leg through `npm run check -- --all`.
- **Evaluations** ([evaluation](../evaluation.md)) measure agent quality, separately from correctness tests.
  Among them, the planted-defect samples in `tasting-room/lenses/` check the review skill and a lens after its prompt changes; no test runs them, and a person compares the run with the sample's table of expected findings.

Foedrum's own code is written test-first, with the red commit before the implementation commit, and every pull request but one of plain documentation goes through a review skill that applies the same red proof, lenses and mutation check Foedrum ships ([ADR 0017](../../adr/0017-test-first-recipes-and-tasting-lenses.md)).

Browser testing *in target repositories* is a recipe concern, not a Foedrum test: a gravity reading can run the repository's own end-to-end suite (`"check": ["test", "npx playwright test"]`), and a verification brewer (Lab tech) can use a browser tool to exercise a UI change and attach screenshots to the pull request (M6).
