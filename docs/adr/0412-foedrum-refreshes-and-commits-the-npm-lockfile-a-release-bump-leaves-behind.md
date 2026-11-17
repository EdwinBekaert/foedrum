# 0412. Foedrum refreshes and commits the npm lockfile a release bump leaves behind

Date: 2026-11-17 · Status: Accepted · Amends [0291](0291-a-release-blocked-sub-order-s-brewers-read-the-release-it-waited-for-as-written.md) (after the bump, Foedrum refreshes the lockfile itself) and [0163](0163-a-repository-s-setup-runs-before-a-brewer-attempt.md) (the setup's sandbox and environment also run a lockfile's refresh, after a brewer attempt)

## Context
A sub-order that waited for a release starts by bumping its dependency to that release (ADR 0291).
The Cellarman edits the manifest, but nothing updates the lockfile.
In an npm app, changing `"greet": "github:<owner>/lib#v1.1.0"` to `#v1.2.0` in `package.json` leaves `package-lock.json` behind.
The green step's `npm ci` then stops: "`npm ci` can only install packages when your package.json and package-lock.json … are in sync" (#760).
The brewer cannot refresh it in a way that works everywhere.
An install needs the registry and a `tools` rule within the Brewery's `permissionCeiling`, and it would run in the brewer's shell, outside the sandbox ADR 0158 gives a setup.

## Decision
- **Foedrum refreshes it, never the brewer.** When a brewer that produces commits ends `succeeded` in a batch whose sub-order waited for a release (the `release` input is not empty, ADR 0291), its runner refreshes the lockfiles before the attempt's end is returned.
  That is after the ADR 0381 send-back, and before green.
  The plan carries this as `refresh`: the repository as Foedrum's own git directories reach it, the attempt's deadline, the setup's environment, and whether no sandbox holds it.
  The Brewery's permission ceiling and the brewer's tool rules do not change.
- **Which lockfiles.** For each `package.json` the attempt's commits changed (outside `node_modules`), the `package-lock.json` beside it, when the tree holds one as a regular file.
  The command is `npm install --package-lock-only --ignore-scripts`, run in that folder.
  npm's documentation says `--package-lock-only` "will only update the `package-lock.json`, instead of checking `node_modules` and downloading dependencies"; `--ignore-scripts` runs no package's scripts, as `npm_config_ignore_scripts` in the setup's environment already says (ADR 0069).
  A repository that keeps no lockfile there gets none.
  A manifest whose path holds a control character or a line or paragraph separator is left out, so a reading's line stays one line.
- **Where it runs.** The refresh runs in a scratch tree of the attempt branch's tip, checked out from a git directory of Foedrum's own, as Brett's mutants run (ADR 0313).
  So it reads exactly what the attempt committed, and none of the brewer's leftovers or git files.
  The line runs through the setup's process runner: the check sandbox with the network kept (ADR 0158, ADR 0218), in a Job Object on Windows, and unsandboxed on native Windows only, its reading saying so.
  It is killed at 5 minutes, or 10 seconds before the attempt's deadline when that is sooner.
- **How it is committed.** Only when every refresh passed, each lockfile a refresh changed is committed on the attempt's branch in the clone by plumbing.
  The blob is written into the clone's objects as a commit of its path stores it, so a checkout's CRLF goes back to the repository's line ends (`hash-object --path`; Git for Windows sets `core.autocrlf`), put on the tip's tree in an index of the git directory's own, and committed by `commit-tree` with the tip as its parent, as Foedrum (the identity the merged tree's commit uses, ADR 0203).
  The branch then moves by `update-ref` only from that tip.
  No hook or configuration of the clone's takes part.
  Nothing resumes in the attempt's worktree after a success: only a retry after a failure resumes, and a route starts fresh (ADR 0117).
  So the worktree, which now lags behind its branch, is never committed on again; an attempt whose refresh did not pass committed nothing, so its retry finds its worktree at its branch.
- **A refresh that does not pass makes the batch Stuck on its environment.** Its reading goes on `step.finished` with `lockfile`, the file it refreshed.
  The attempt ends `blocked`, `environment`, as a setup that did not pass does (ADR 0140): `the lockfile <path> could not be refreshed: "<command>" failed with exit code <n>`, or was ended, timed out, wrote too much, or could not start.
  A stop cancels it, also while git lists the changed paths or commits.
  When the changed paths cannot be listed, the scratch tree cannot be made, or the runner has no process runner for it, the attempt ends `blocked`, `environment`: `the lockfiles could not be refreshed: <why>`.
- **Left out.**
  - `npm-shrinkwrap.json`: npm's documentation does not say what `--package-lock-only` does to it.
  - Cargo's `Cargo.lock` and NuGet's `packages.lock.json`: #1127 will add them on this machinery (`cargo update --workspace`, `dotnet restore`).
  - Go's `go.sum`: `go mod tidy` also adds and removes requirements in `go.mod`, and no documented command only adds the missing `go.sum` entries.
  - An interactive step's session: a person runs that step and its install.

## Security
The refresh runs npm on a `package.json` a brewer wrote, as a repository's setup already does before every brewer attempt and check step (ADR 0163).
It runs in the same sandbox with the same environment, adding `--ignore-scripts`.
So no row of [docs/trust-boundaries.md](../trust-boundaries.md) gains a risk: the row "A check step running code a brewer wrote" names it beside the setup.
Its commit is read by the push's secret scan (ADR 0079), not by the scan of the attempt's commits (ADR 0187), which ran before it.
No safeguard is added.

## Consequences
- A release-blocked sub-order's pull request carries the refreshed `package-lock.json` beside the bump, and green's `npm ci` reads them in sync.
- A batch whose sub-order waited on no release, and a brewer that does not commit, refresh nothing.
- **Not checked:** whether npm resolves a `github:<owner>/<name>#<tag>` dependency inside the setup's sandbox.
  A real run must confirm that npm reaches GitHub there (through git or codeload) with the sandbox's empty home and no credentials, for a public repository.
  If it cannot, the batch goes Stuck on its environment naming the lockfile, rather than failing green.
- **Brewery migration:** none. A repository that pins a dependency by tag and keeps `package-lock.json` gets the lockfile refreshed in the bump's pull request; one without a lockfile is unchanged.

## Alternatives considered
- **The brewer runs the install itself.** It needs a `tools` rule for `npm install` within the ceiling, the registry from the brewer's shell, and it runs outside the setup's sandbox.
- **Refresh in the green step's worktree before its setup.** Green commits nothing, so the pull request would still carry the stale lockfile and the repository's own CI would fail.
- **Refresh in the attempt's worktree and commit there.** The worktree's git files are the brewer's to write (ADR 0074), and its untracked leftovers would take part in the refresh.
