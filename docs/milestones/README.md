# Milestones

Foedrum is built in milestones. Each one ends with an exit criterion that a test or a real run
proves, not with a list of tasks. They are tracked as
[GitHub milestones](https://github.com/EdwinBekaert/foedrum/milestones). Each closed milestone
gets a page here that says what it built.

| Milestone | Builds | Exit criterion | Status |
|---|---|---|---|
| [M0 — Foundations](m0.md) | The engine underneath everything: event store, state machine, supervisor, driver, fake runner, platform layer, property and chaos tests, CI on three platforms | 1,000 chaos runs with random engine kills: no lost or duplicated side effects, no silent stalls | Closed 2026-10-17 |
| [M1 — First pour](m1.md) | Polling intake, the Nip recipe (test-first), the claude CLI runner, worktrees from local clones, gravity readings, an opened pull request, a status comment | A real issue in a test Brewery becomes a pull request end to end, covered by an automated E2E test on all three platforms | Open |
| M2 — The ladder | Brewer and recipe files, the router, sub-orders per repository, bottling, code and release dependencies, Conditioning, rewind, tasting, loops, commands, budgets, house yeast | An order across two repositories, where the second needs a release of the first, ends with two linked pull requests and the version bump | Open |
| M3 — Public launch | README, docs, demo, trusted publishing, contribution guide and CLA, trademark policy, the repository public | `npx foedrum init` works on Windows, macOS and Linux | Open |
| M4 — Blind tasting | The tasting room repository, the Flight runner, reports, a model watcher that opens upgrade pull requests | An automatically opened model-upgrade pull request with an evaluation report | Open |
| M5 — Strong ales | Larger recipes at scale, triage of target-repository issues, re-pitch, managed clones, pre-release development, GitHub App auth, packs | Target-repository bug reports become Brewery orders with confirmed root causes | Open |
| M6 — Brewhouse | A local dashboard, the tasting log, diagnostics, verification in real environments, browser E2E, a visual recipe editor | A live board of all batches, and a recipe edited visually and saved as a pull request | Open |

The words (Brewery, order, batch, brewer, bottle, on tap) are in the [glossary](../glossary.md).
