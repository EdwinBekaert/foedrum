# 0254. Foedrum supports SHA-1 repositories

Date: 2026-10-28 · Status: Accepted · Amends [0074](0074-git-commit-grants-fixed-git-rules-and-done-needs-a-commit.md) (the start of a commit count is a SHA-1 sha, no longer a SHA-1 or SHA-256 one)

## Context
git names an object by its SHA-1 (40 hex characters) or, in a repository made with `--object-format=sha256`, by its SHA-256 (64).
Foedrum checked a full commit id in seven places, and they disagreed (#624, found by a code audit of main at `b01300bb`, [ADR 0245](0245-brew-audit-a-read-only-audit-of-the-code-at-every-last-call.md)):

- `CommitSha` (`src/schemas/store.ts`) and the readers of attempt commits, the base merge, the merge tree and a plan's paths accepted 40 or 64 characters.
- The commit scan's commit line accepted 40 or 64, while its commit candidates were 40 only.
- The branch push ([ADR 0090](0090-the-push-fetches-the-base-in-a-git-directory-of-its-own.md)) accepted 40 only.

So the code read as if SHA-256 repositories worked, while the push refused every 64-character commit after a brewer's work was done.
GitHub hosts only SHA-1 repositories, so no path reached the mismatch.

## Decision
- **Foedrum supports SHA-1 repositories.** A full commit id is 40 lowercase hex characters (the maintainer's decision, 2026-10-28).
- **One check owns it**: `isCommitSha` in `src/schemas/store.ts`, which every git reader uses, and whose pattern `CommitSha` uses. A reader whose line holds an id among other text (the merge tree's copied refs, the commit scan's commit line) splits the line and asks the same check. The scans for ids inside other text (the secret scan's commit candidates, the push's strip of each patch's sha) build their pattern on the same `COMMIT_HEX`.
- **A 64-character id is refused where it enters**, with a line that names it: `<id> is a SHA-256 commit id: Foedrum supports SHA-1 repositories only` (`noCommitSha`). That is an id the engine gives a git reader, before git runs, and an id git answers with where Foedrum checks one: the push's commit and its base fetch, the base merge's HEAD and the state branch's remote commit. `CommitSha` refuses it with its own message, `Must be a full commit sha: 40 lowercase hex characters (SHA-1 repositories only)`.
- **`foedrum doctor` does nothing new.** A SHA-256 checkout fails at the first of those reads it reaches, with the line above.

## Consequences
- The checks agree, so a SHA-256 repository fails at its first commit id, not after a brewer's work is done.
- A SHA-256 host is a later decision: the check is in one place, and so is the change.

## Alternatives considered
- **Accept both everywhere and prove it on a `--object-format=sha256` clone.** It would test a host no user has: GitHub hosts no SHA-256 repository.
- **A doctor check of the checkout's object format.** It would be a second layer for a refusal the first git read already makes, against a host no user has.
