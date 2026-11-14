# 0399. CI runs the tests against the installed claude, with a claude pinned in a lockfile of its own

Date: 2026-11-14 · Status: Accepted · Amends [0057](0057-real-claude-tests-are-opt-in-and-claude-proofs-leave-the-suite.md) (CI runs its opt-in tests), [0121](0121-the-m1-end-to-end-test-runs-nip-through-serve-with-real-git-and-checks-and-faked-github-and-brewers.md) (its run with the real `claude` is no longer "never in CI"), [0241](0241-each-test-runs-at-the-stage-where-it-pays-the-check-runs-the-test-files-a-change-reaches.md) (`scripts/affected-tests.ts` also lists the tests against the installed `claude` a change reaches) and [0004](0004-built-in-first-dependency-policy.md) (a tool CI alone installs is recorded apart from the admitted packages)

## Context
ADR 0057 made the tests of Foedrum's code against the installed `claude` opt-in, with `FOEDRUM_REAL_CLAUDE=1`, and left them out of CI, which had no `claude`.
They need no login and spend no token: `test/integration/fake-messages-api.ts` stands in for the model.
They hold the security rules of ADR 0093 and ADR 0049 (a brewer's file tools and reads stay inside its worktree), ADR 0062 (`git push` refused however it is written) and ADR 0042 and ADR 0046 (the runner's settings file is read).
Nothing recorded when one last ran, and one had stopped passing unseen: `serve.test.ts` failed on every tick since #239 made the intake's listing need each issue's `created_at`, which its fake GitHub did not give, and four later changes each added a read the fake did not answer (#900).
On the Windows leg two other tests never ran: `below-normal-priority.test.ts`, because the runner starts the job below normal, and read-guard's short name inside the checkout, because short names are off on the runner's checkout drive.

## Decision
- **CI runs the tests against the installed `claude`** in a job of its own, `real-claude`, on Windows, Linux and macOS, with `FOEDRUM_REAL_CLAUDE=1` and the fake Messages API only: no login, no token, no real model, no real GitHub repository.
  - The nightly run (and one started by hand) runs every one.
  - A pull request runs the ones its change reaches: `node scripts/affected-tests.ts --real-claude` follows the same imports as `npm run check` (ADR 0241) to the integration tests that import `test/helpers/real-claude.ts`, and lists every one when the change reaches every test file. A push to `main` reaches none.
  - `ci-ok` needs the job, so a pull request that breaks one of them is not merged.
- **`claude` is pinned.** `ci/claude/` holds a `package.json` with `@anthropic-ai/claude-code` at an exact version (2.1.310, the version #900 ran them with), its `package-lock.json` with each platform package's sha512 integrity, and an `.npmrc` with the root's hardening, which npm reads for a nested package from its own folder only.
  - `npm ci --prefix ci/claude` installs it with install scripts off. The package's `postinstall` (`install.cjs`) downloads nothing: it only copies the binary of the platform package npm already installed over a stub. So the job puts that platform package's folder on `PATH` instead, and no script runs.
  - Dependabot proposes each new version as a pull request (`/ci/claude`, the same 7-day cooldown).
  - It is not part of the package: `package.json`'s `files` names none of `ci/`.
- **It is a CI-only tool, not an admitted package.** `DEPENDENCIES.md` records it under "CI-only tools": the pin, the lockfile's place, and why the admission checklist's points on install scripts, provenance and the licence do not apply to a tool that no user installs, that Foedrum does not ship and whose script never runs. Each Dependabot bump gets a diff review. Of ADR 0004's CI controls, the job keeps `npm ci` with the lockfile's sha512 integrity and leaves out the lockfile checker (`scripts/check-deps.ts` reads the root lockfile only, as before) and `npm audit signatures`: the package carries no provenance to check, and the integrity hashes pin the bytes the reviewed bump accepted.
- **The two Windows skips:**
  - The priority test raises its own process back to normal on Windows, which needs no privilege there, and lowers it again after; it skips only where that is refused.
  - CI turns short names on for the checkout drive (`fsutil 8dot3name set`) before the tests that make a folder and read it by its short name, in the `check` job, which runs read-guard's short-name test; in `real-claude` that test, which needs no `claude`, skips.
- **On a developer's machine nothing changes.** The tests stay opt-in there, against whichever `claude` is installed.
- **No Brewery migration.** Nothing a Brewery holds or does changes.

## Consequences
- The job runs whole files, so the tests in `nip.test.ts` and `read-guard.test.ts` that need no `claude` run there a second time, about 10 s per leg; picking the opt-in tests out by name would tie CI to their names.
- A change that breaks one of these tests fails its pull request when it reaches the test, and the nightly run catches the rest.
- CI downloads a platform binary of about 300 MB per leg when the job runs; a nightly leg takes about 6 to 10 minutes.
- A new `claude` version reaches CI only through a reviewed Dependabot pull request, which runs every one of these tests, since it changes a non-TypeScript file.
- A test that skips when a tool is missing still reads as passed; the opt-in still fails when asked for without `claude` (ADR 0057).

## Alternatives considered
- **Install `claude` with its install script, or with the native installer.** Rejected: the script is not needed, and the native installer downloads an unpinned version outside any lockfile.
- **Add `claude` to the root `package.json` as a dev dependency.** Rejected: every contributor's `npm ci` would download it, and the dependency guard's budget and admission rules are for what Foedrum builds and ships with.
- **Run the job on every pull request.** Rejected: about 300 MB and several minutes per leg on changes that cannot reach these tests.
- **Extend `check-deps.ts` to the CI lockfile.** Rejected for now: no failure calls for it, and the lockfile's integrity hashes and Dependabot's reviewed bumps cover the pin.
