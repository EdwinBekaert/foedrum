# Testing strategy

Stability is proven, not claimed.

| Page | What it covers |
|---|---|
| [Unit tests](unit.md) | No processes, the CPU-time budget |
| [Integration tests](integration.md) | A few per tool boundary |
| [Fake brewer runner](fake-runner.md) | Scripted brewer behaviours |
| [Property tests](property.md) | Invariants I1–I6 on generated scenarios |
| [Chaos tests](chaos.md) | The real driver, killed at random points |
| [End-to-end tests](end-to-end.md) | Contract, end-to-end and browser tests |

No test of any layer holds the wall clock to a limit, since load from other sessions stretches it (only a lower bound may read it, [ADR 0075](../../adr/0075-only-a-lower-bound-reads-the-wall-clock-and-doctor-runs-against-stub-tools.md)): deadlines and timers are injected and driven by the test, "at once" is proven by an order of events, a wait for an end is only guarded against a hang, and a performance property is measured in CPU time ([ADR 0070](../../adr/0070-tests-never-hold-the-wall-clock-to-a-limit.md)).

- **Cross-platform:** every test layer runs on Windows, macOS and Linux in CI ([cross-platform rules](../platform/cross-platform.md)).
- **Evaluations** ([evaluation](../evaluation.md)) measure agent quality, separately from correctness tests.

Foedrum's own code is written test-first, with the red commit before the implementation commit, and every pull request goes through a review skill that applies the same red proof, lenses and mutation check Foedrum ships ([ADR 0017](../../adr/0017-test-first-recipes-and-tasting-lenses.md)).
CI enforces coverage thresholds with Node's built-in coverage.

Browser testing *in target repositories* is a recipe concern, not a Foedrum test: a gravity reading can run the repository's own end-to-end suite (`"check": ["test", "npx playwright test"]`), and a verification brewer (Lab tech) can use a browser tool to exercise a UI change and attach screenshots to the pull request (M6).

Published metrics: chaos runs passed, stuck-without-transition count (target 0), orchestration overhead, evaluation scores per model.
