# Who guards what

One row per risk, and one owner per row: the single place that handles it. A new safeguard names its row first (CLAUDE.md, Security). If the row's owner already handles the risk, the answer is to improve the owner, or nothing. A second layer is only added with a decision recorded in an ADR that says what it catches that the owner misses; those are listed in the last column. Adding a row is the maintainer's decision.

[The security model](design/security.md) describes how each owner works. This page only says which one is responsible.

| Risk | Owner | Recorded second layers |
|---|---|---|
| A brewer reaching outside its worktree: files, network, credentials, the clone's git settings | Claude Code's sandbox, with the attempt settings Foedrum writes (tool allow and deny rules, `--setting-sources ""`, the minimal environment, the toolchain folders they re-open to reads, ADR 0162) | ADR 0062 (no git without a fixed subcommand), ADR 0109 (a brewer's git holds no push credential; the `noPush` guard is gone, ADR 0133), ADR 0160 (ADR 0087's credential entries kept under the read block, for the paths it re-opens or does not reach) |
| A check step running code a brewer wrote | The check sandbox: no network for checks (#190), the network kept for a repository's setup, before check steps (ADR 0158) and brewer attempts (ADR 0163), on Linux and WSL2 through a network namespace of its own that a user-mode network stack joins, away from the host's loopback and abstract Unix sockets (ADR 0218), slirp4netns under its seccomp filter (ADR 0277); the same for the checks on an open pull request's merged tree, whose repository's borrowed object stores it binds read-only only from a git directory Foedrum alone writes, a direct `.git` child of a repository's `git-dirs/` by real path, never from a worktree a brewer or a check writes, the merged tree's `<uuid>.tree` there included (ADR 0203) | |
| Bad code reaching `main` | The pull request: CI on three platforms, the review (`/brew-review`), the maintainer's merge, and the ruleset requiring `ci-ok` | |
| A session skipping the procedure: merging, force-pushing, pushing without the check, marking ready without a review | The local gate (`scripts/precheck.ts`) | |
| A secret in what is pushed or posted | GitHub secret scanning and push protection (ADR 0113) | ADR 0079 (the push scans a batch's commits before it leaves; ADR 0187 runs the same scan on each committing brewer's `done` attempt, so its retry can fix it, and keeps the push's as the last line), ADR 0114 (the personal denylist), ADR 0088 (out doc text that looks like a secret is left out of the pull request body and the status comment), ADR 0209 (a check that fails on an open pull request's merged tree posts the tail ADR 0069 read for secrets when it was recorded, and no second read), ADR 0228 (a failed Actions job's log excerpt is read for secrets as a check's tail is before it is recorded, and so is the line why it could not be read, which quotes gh's error, since the event log goes to the state branch and the excerpt to a fix step's prompt) |
| Model text in what the engine posts on GitHub closing an issue or pinging people | The engine's frame of the pull request body: the reports fenced, the `Closes` line its own, and the unfenced sections without mentions, closing keywords, character references, open fences or HTML blocks (`unlinked`, ADR 0167) | |
| Untrusted text steering a model | Nonce tags around every input, allow-listed authors (ADR 0041) | |
| Foedrum's own dependencies | The dependency policy (ADR 0004, DEPENDENCIES.md) | |
| The engine's state after a crash, a kill or a second driver | The event store, leases and locks; these are the engine's correctness, not safeguards in this sense | |

## What is not a row

Doing the code right needs no row and no proof: validating input where it enters, handling error paths, comparing values the way their domain does, normalising paths, and reading commands the way the shells do where the code's contract says so (ADR 0045).
