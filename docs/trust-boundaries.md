# Who guards what

One row per risk, and one owner per row: the single place that handles it. A new safeguard names its row first (CLAUDE.md, Security). If the row's owner already handles the risk, the answer is to improve the owner, or nothing. A second layer is only added with a decision recorded in an ADR that says what it catches that the owner misses; those are listed in the last column. Adding a row is the maintainer's decision.

[The security model](design/security.md) describes how each owner works. This page only says which one is responsible.

| Risk | Owner | Recorded second layers |
|---|---|---|
| A brewer reaching outside its worktree: files, network, credentials, the clone's git settings | Claude Code's sandbox, with the attempt settings Foedrum writes (tool allow and deny rules, `--setting-sources ""`, the minimal environment, the toolchain folders they re-open to reads, ADR 0162) | ADR 0062 (no git without a fixed subcommand), ADR 0109 (a brewer's git holds no push credential; the `noPush` guard is gone, ADR 0133), ADR 0160 (ADR 0087's credential entries kept under the read block, for the paths it re-opens or does not reach) |
| A check step running code a brewer wrote | The check sandbox: no network for checks (#190), the network kept for a repository's setup, before check steps (ADR 0158) and brewer attempts (ADR 0163) | |
| Bad code reaching `main` | The pull request: CI on three platforms, the review (`/brew-review`), the maintainer's merge, and the ruleset requiring `ci-ok` | |
| A session skipping the procedure: merging, force-pushing, pushing without the check, marking ready without a review | The local gate (`scripts/precheck.ts`) | |
| A secret in what is pushed or posted | GitHub secret scanning and push protection (ADR 0113) | ADR 0079 (the push scans a batch's commits before it leaves), ADR 0114 (the personal denylist) |
| Untrusted text steering a model | Nonce tags around every input, allow-listed authors (ADR 0041) | |
| Foedrum's own dependencies | The dependency policy (ADR 0004, DEPENDENCIES.md) | |
| The engine's state after a crash, a kill or a second driver | The event store, leases and locks; these are the engine's correctness, not safeguards in this sense | |

## What is not a row

Doing the code right needs no row and no proof: validating input where it enters, handling error paths, comparing values the way their domain does, normalising paths, and reading commands the way the shells do where the code's contract says so (ADR 0045).
