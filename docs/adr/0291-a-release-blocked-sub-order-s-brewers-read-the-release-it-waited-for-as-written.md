# 0291. A release-blocked sub-order's brewers read the release it waited for, as written

Date: 2026-11-01 · Status: Accepted · Amends [0216](0216-a-release-blocker-is-done-once-its-repository-is-released-after-its-merge.md) (the release that makes a `release` dependency done is an input of the sub-order's batch, and `release.observed` keeps the release's page and notes), [0223](0223-the-intake-records-a-release-that-holds-a-waiting-release-blocker-s-merge.md) (the intake records a release's page and notes with its tag), [0013](0013-single-repo-sub-orders-bottles-and-releases.md) (the dependent batch bumps the dependency from that input; Foedrum parses no version) and [0197](0197-acceptance-ships-as-a-default-diff-lens-and-nip-tastes-through-it-beside-correctness.md) (the acceptance lens judges the bump as part of what the change builds)

## Context
A sub-order with a `release` dependency waits until its blocker's pull request merged and a release of its repository is recorded after that merge (ADR 0216, ADR 0223).
The sub-order's batch then starts, but no brewer input carries the release it waited for, so its brewers cannot bump the dependency to it, which ADR 0013 and the work breakdown say the dependent batch's recipe does.
That is the first gap to M2's exit test: an order across two repositories, the second needing a release of the first, ends with two linked pull requests and the version bump.
How a repository versions and releases is its own CI's business: a tag, semantic-release, changesets, `pkg@1.4.0` tags, a date.
The maintainer decided on 2026-10-31 (#736) that Foedrum never computes or parses a version.

## Decision
- **A brewer input source `release`**: `{ "name": "release", "from": "release" }`, for each `release` dependency of the batch's sub-order, the release that made it done.
- **The release is the one the ready set counted**: the first recorded release of the blocker's repository, in any case, after a merge of the blocker, found by the one function the ready set judges the dependency with, so the two cannot drift.
  With it come the blocker's pull requests merged before it.
- **It is written as the code host wrote it.** Its text names the repository, the tag as recorded (`release.observed`'s `version`, never parsed), the release's page, the merged pull requests and the release's notes, read with CRLF or LF line ends and written with LF; a record with no page (a bare tag, an older record, a refused URL) says only that no page is recorded, and one with no notes shows none.
  The brewer reads the version from the released repository at that tag (its manifest, or the notes), the way a person would, and the dependent repository's own checks prove the bump.
- **`release.observed` gains an optional `url` and `notes`**, filled when the latest is a release, not a bare tag: its `html_url`, kept only when it is https without credentials, and its body, filtered for secrets as below and then cut to 4,000 characters after its last whole line, so no line is cut in the middle (a first line longer than that is cut on a code point).
  An event recorded before has neither and folds as before.
  An attempt's planning reads only the recorded state, never the code host.
- **The notes are the released repository's text, untrusted model input.** When the intake records them, with LF line ends, each line that looks like a secret is left out, and a last line says how many were, so a brewer knows the notes are incomplete; the count line is kept when the rest is cut.
  A full commit hash is no secret there: the notes publish it, as a changelog's link to a commit does.
  The record and the input hold the same filtered notes, and the input goes between nonce tags as data like every input (ADR 0041).
  The path this closes: a released repository's maintainer or its CI writes a credential into a release's notes, and the input would send it to the model provider in a brewer's prompt, where no push scan reads (ADR 0079, ADR 0187 and GitHub's push protection read what is pushed, not what a prompt holds); a brewer that copied it into its change or out doc would then put it in front of those scans only after it was sent.
  The record is a second path: the event log goes to the state branch, as a failed job's log does (ADR 0228), where push protection matching a recorded token would refuse every later push of an append-only log.
  So the filter serves the row "A secret in what is pushed or posted" of [docs/trust-boundaries.md](../trust-boundaries.md), at the point the text enters the record, not a new row.
  It is the filter the plan entry's text already goes through before it enters a prompt (ADR 0290), applied line by line because notes are many lines of Markdown.
- **A batch whose sub-order waits on no release** (every order, and a sub-order with only `code` blockers) leaves the input out (ADR 0064), so its prompt reads as before.
- **The Gauger, the Cellarman and the Taster read it.** The Gauger's and the Cellarman's prompts say the change starts by moving the dependency on that repository to that release, found in the worktree's own manifests and read from the released repository at the tag, never guessed.
  The acceptance lens judges the bump as an item of what the change must build; the test-design lens leaves proving it to the repository's own checks.

## Consequences
- A release-blocked sub-order's pull request carries the version bump of the release it waited for.
- A repository that versions in a way Foedrum never heard of works the same: nothing in Foedrum reads the tag's form.
- A later release of the same repository does not change what a batch reads: its input stays the release that started it.
