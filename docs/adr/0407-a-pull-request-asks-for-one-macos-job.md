# 0407. A pull request asks for one macOS job

Date: 2026-11-16 · Status: Accepted · Amends [0377](0377-the-package-ships-the-javascript-tsc-emits-and-ci-starts-the-installed-tarball.md) (the `package` job on macOS for every pull request), [0388](0388-a-tag-on-a-green-main-publishes-through-trusted-publishing-and-a-dry-run-proves-the-rest.md) (the package workflow takes an input, and a pull request's run of it leaves out macOS) and [0399](0399-ci-runs-the-tests-against-the-installed-claude-with-a-claude-pinned-in-a-lockfile-of-its-own.md) (the `real-claude` job on macOS for every pull request)

## Context
Every pull request's CI run asked GitHub for three macOS jobs: `check`, `real claude` and `package`.
On 2026-11-16, with four sessions pushing, the macOS `check` and `real claude` jobs of #1093, #1092 and #1095 got no runner and were cancelled after 15 minutes with no step run, while `package (macos-latest)` in the same runs got one.
Over the last 25 CI runs, 11 of 72 macOS jobs never started or were cancelled; some may be runs a newer push cancelled, which were not separated.
The likely cause is GitHub's limit on concurrent macOS jobs per account, not checked against GitHub's documentation.
A pull request whose macOS job never starts has no green `ci-ok`, so it waits for a rerun (#1098).

## Decision
- **On a pull request, `check` is the one macOS job.** `real-claude` and `package` run on `ubuntu-latest` and `windows-latest` only.
  `check` keeps all three, so every test layer still runs on macOS for every pull request ([ADR 0010](0010-cross-platform-and-isolation-levels.md) is unchanged).
- **Everywhere else, macOS as before.** A push to `main`, the nightly run and a run by hand run all three jobs on macOS.
  On a push to `main`, `real-claude` still runs none of its tests, as [ADR 0399](0399-ci-runs-the-tests-against-the-installed-claude-with-a-claude-pinned-in-a-lockfile-of-its-own.md) decided: its tests run on macOS only in the nightly run and a run by hand.
- **The release keeps macOS.** `package.yml` takes a boolean input, `macos`, whose default is `true`; CI passes `false` on a pull request only.
  The release's `smoke` job passes nothing, so it packages on all three platforms before it publishes ([ADR 0388](0388-a-tag-on-a-green-main-publishes-through-trusted-publishing-and-a-dry-run-proves-the-rest.md)).
  The system names stay in `package.yml`.
- **`ci-ok` does not change.** A matrix leg left out of a run is never created, so it is neither skipped nor failed, and a job's `needs` result covers only the legs that ran: `success` when the Linux and Windows legs pass, `failure` when one of them fails.
  Where the macOS legs run, their result counts as before.

## Consequences
- A pull request asks for one macOS runner instead of three.
- A change that breaks the package on macOS alone passes its pull request and fails the run of its merge on `main`; the release's `smoke` job packages on macOS too, so such a break is not published.
- A change that breaks a test against the installed `claude` on macOS alone passes its pull request and the run of its merge, and fails the next nightly run.
  A tag cut before that run is not held back by it: the tag's guard reads only the run of the push.
- A pull request that changes `package.yml` or `release.yml` still packages on macOS in the release's dry run.
- **Brewery migration:** none: this is CI only.

## Alternatives considered
- **Keep the three and rerun what got no runner:** each rerun asks the same limited pool again, and a person must notice the cancelled job.
- **Leave out macOS `check` instead:** `check` runs every test layer, the one that catches most platform bugs; `package` and `real-claude` cover narrower paths, which the run on `main` (for `package`) and the nightly run still check on macOS.
- **Pass the list of systems to `package.yml`:** each caller would spell the names; a boolean states only whether macOS runs.
