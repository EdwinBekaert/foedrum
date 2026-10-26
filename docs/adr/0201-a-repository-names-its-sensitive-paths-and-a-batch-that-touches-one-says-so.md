# 0201. A repository names its sensitive paths, and a batch that touches one says so

Date: 2026-10-26 · Status: Accepted · Amends [0023](0023-language-independent-recipes.md) (a repository's entry may name `sensitivePaths`), [0071](0071-the-openpullrequest-action-two-effects-of-the-batch.md) (the push's ledger result keeps the sensitive files the change touches) and [0072](0072-the-status-comment-edits-as-revisions-in-the-ledger.md) (the status comment names them)

## Context
Foedrum never merges: a person merges every pull request it opens.
Its tasting is as deep whatever a batch's change touches, and nothing tells the person who merges where the risk is: a change to the CI configuration, the authentication code or a data migration reads like any other.
#272 was settled with the maintainer on 2026-10-25: show only, first.
A repository names its sensitive paths, and a batch whose change touches one says so as a fact, never as an approval or a block.
Deeper tasting on sensitive paths, the spread and test signals, and the same treatment for `/brew-review` on Foedrum's own sensitive paths are issues of their own.

## Decision
- **`sensitivePaths` in a repository's entry of `foedrum.jsonc`**: a list of path globs, relative to the repository's root with `/` between folders, as `posix.matchesGlob` reads them (the house-yeast rules' globs, [ADR 0169](0169-house-yeast-rules-reach-a-batch-s-brewers-by-scope-and-lens.md)), such as `.github/workflows/**` or `src/auth/**`.
  There are no defaults: without the field, or with an empty list, nothing is matched and nothing is shown.
  A glob that is blank, starts at `/` or `!`, holds a `\` or has a `.` or `..` segment is refused when the file is loaded, with one line: it would match nothing git names, or not what it seems to.
- **Matched once, at the push of the batch's pull request** (the openPullRequest action, ADR 0071): the files of `git diff --name-only -z --no-renames` from where the batch's change starts to the commit pushed, as a diff Taster's change input starts it ([ADR 0161](0161-lens-steps-run-a-taster-whose-findings-are-advisory-unless-the-step-blocks.md), after a merge of the base at the base it merged, [ADR 0164](0164-a-batch-merges-its-base-before-its-last-check.md)).
  Every file the change adds, alters or deletes counts, and a rename counts at both paths: removing a workflow touches it too.
  The git call runs only when the repository names a glob and the push carries commits; a batch with no recorded start matches nothing.
- **The matches are recorded on the push's ledger result** (`PushResult.sensitive`, `src/schemas/store.ts`): how many files matched and the first 50 of them, as git named them.
  No event type changes: the result is the push effect's `effect.applied`, recorded once, so a restart, `foedrum replay` and a rewind read the same matches and never match again.
- **The status comment shows one line** after the pull requests, when the push recorded matches: `Touches sensitive paths:` and the first 10 files, each escaped to one plain line and cut as every other text a committer wrote, with a count of the rest (`sensitiveLine`, `src/engine/status-comment.ts`).
  A batch whose change touches none, and a repository without the field, show nothing.
- **Never an approval or a block.** No lane, route, label or tasting reads the matches; the recipe's tasting is unchanged.
- **The merge brief (#274) will show the same line** once it exists, from the same record.

## Consequences
- The person who merges sees, on the order's issue, which sensitive files a batch's pull request touches, without opening its diff.
- One more `git diff` in the clone per pushed pull request of a repository that names globs.
- A log written with `sensitive` on a push result cannot be read by an older Foedrum, whose `PushResult` is strict.
- A batch pushed before its repository named globs, or before this change, shows nothing: matches are never recomputed.
- The files named passed the push's secret scan ([ADR 0079](0079-the-push-scans-the-batch-s-commits-for-secrets.md)) before they are recorded, since nothing is recorded for a refused push's files beyond its findings.

## Alternatives considered
- **Defaults** (`.github/workflows/**`, lock files): settled against for now; every repository names its own, and a default can come once a brew shows which ones every repository wants.
- **A new event for the matches.** The push's ledger result is already the record of what the pull request carries, and an event type would make every older log reader fail for a line of text.
- **Match on every status edit.** The files would be read again each revision, and a commit pushed later by someone else would change what Foedrum says of its own push.
- **A label on the pull request.** A label reads like a verdict and needs a ledger effect of its own; the line says the same as a fact.
