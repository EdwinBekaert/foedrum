# 0391. Contributors sign a CLA licence grant in a signatures file, and CI checks the pull request's author

Date: 2026-11-13 · Status: Accepted · Amends [0009](0009-agpl-and-cla.md) (the CLA is a licence grant, signed in a file, checked by CI)

## Context
[ADR 0009](0009-agpl-and-cla.md) licenses Foedrum under the AGPL-3.0 and asks a Contributor License Agreement of contributions, so the project can relicense or offer a commercial licence beside the AGPL, and says it must be in place before outside contributions are accepted.
It left open what kind of agreement, how a contributor signs it, and how a pull request is held to it.
A Developer Certificate of Origin would leave each contribution under the AGPL only, which closes the commercial licence ADR 0009 keeps open.
The maintainer decided on #1024 (2026-11-13): a CLA as a licence grant, from an established template, signed in a file, checked by a CI job of Foedrum's own.

## Decision
- **The agreement:** `CLA.md`, version 1.0, adapted from the Apache Software Foundation's Individual Contributor License Agreement V2.2, which it names at the top with its licence and lists its changes at the end.
  It is a licence grant, not a copyright transfer: the contributor keeps the copyright and grants the maintainer a perpetual, worldwide, non-exclusive, royalty-free, irrevocable copyright licence that includes sublicensing and licensing under any terms, commercial ones included, and a patent licence.
  A lawyer reads it before the first outside pull request is accepted.
- **Signing:** a contributor adds `- @<login>, CLA <version>, <YYYY-MM-DD>` to `.github/cla-signatures.md` in a commit of its own in their first pull request.
  The history records who signed which version, and when.
  A signature of any version counts for now; a later version that needs signing again gets its own ADR.
- **The check:** `scripts/cla-check.ts`, a thin shell over a pure core, `scripts/cla-check/core.ts` ([ADR 0021](0021-unit-tests-spawn-no-processes.md)).
  A line counts only when it is the whole signature form, and logins compare without regard to case, as on GitHub.
  The repository owner, who receives the licence, and `dependabot[bot]` are exempt; the owner comes from the event payload, so no login is written in the script.
  When the author has not signed, it fails with one line that says how to sign.
- **The CI job:** `cla` in `ci.yml`, on `pull_request` only (never `pull_request_target`), with `contents: read`.
  It checks out the pull request's head without credentials and runs only node on the script, with no `npm ci`.
  The author (`pull_request.user.login`) and the owner (`repository.owner.login`) reach it through `env`, never through the run line.
  `ci-ok` needs it: success on a pull request, skipped on a push or the nightly run.
- No third-party CLA bot or action, no comment on the pull request, and no check of every commit's author: the pull request's author signs.

## Consequences
- An outside contributor signs once, in the pull request itself, with no account elsewhere and no form.
- The check is a reminder for honest contributors, not a guard.
  On `pull_request` the workflow file and the script both come from the pull request, so an author can edit them to pass; checking out the base branch's script would not change that, since `ci.yml` itself comes from the pull request.
  The maintainer's review and merge are the guard, the owner of "Bad code reaching `main`" in [trust-boundaries.md](../trust-boundaries.md), so the check adds no row there.
- A commit by someone other than the pull request's author is covered only by that author's signature.
- The check counts a signature line whoever committed it, so a line added for another login is caught at the merge: the maintainer checks that a new signature line names the pull request's author.
- The CLA text carries the maintainer's name as the party who receives the licence.
- A Brewery needs no migration: nothing a Brewery holds or does changes.

## Alternatives considered
- **A Developer Certificate of Origin:** no licence beyond the AGPL, which closes the commercial licence.
- **A Harmony agreement:** also established, but the Apache ICLA is the more widely read text, and its grant already holds the licence and patent terms the maintainer decided on.
- **A third-party CLA bot or action (CLA Assistant and the like):** an outside service or action with write access to pull requests, where a file and a script of a few lines do the same.
- **`pull_request_target`:** runs with a write token on the base branch's code, the setting most often abused to run a fork's code with secrets; the check needs neither.
