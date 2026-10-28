# 0254. Foedrum supports SHA-1 repositories

Date: 2026-10-28 · Status: Accepted

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
- **One check owns it**: `isCommitSha` in `src/schemas/store.ts`, which `CommitSha` and every git reader use; a reader whose line holds an id among other text (the merge tree's copied refs, the commit scan's commit line) splits the line and asks the same check.
- **A 64-character id is refused where it enters**, with a line that names it: `<id> is a SHA-256 commit id: Foedrum supports SHA-1 repositories only` (`noCommitSha`), and `CommitSha`'s message says the same.
- **`foedrum doctor` does nothing new.** A SHA-256 checkout fails at the first git read that meets one of its commits, with the line above.

## Consequences
- The checks agree, so a SHA-256 repository fails at its first commit id, not after a brewer's work is done.
- A SHA-256 host is a later decision: the check is in one place, and so is the change.

## Alternatives considered
- **Accept both everywhere and prove it on a `--object-format=sha256` clone.** It would test a host no user has: GitHub hosts no SHA-256 repository.
- **A doctor check of the checkout's object format.** It would be a second layer for a refusal the first git read already makes, against a host no user has.
