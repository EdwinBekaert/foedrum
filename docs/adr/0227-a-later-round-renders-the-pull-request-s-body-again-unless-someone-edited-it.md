# 0227. A later round renders the pull request's body again, unless someone edited it

Date: 2026-10-27 · Status: Accepted · Amends [0219](0219-a-failing-check-on-an-open-pull-request-sends-its-batch-back-to-a-fix-step.md) (a later round's push renders the body again), [0071](0071-the-openpullrequest-action-two-effects-of-the-batch.md) (a third effect in a later round) and [0167](0167-a-brewed-pull-request-follows-one-layout-and-opens-as-a-draft-unless-every-taster-approves.md) (the body ends with a marker)

## Context
A brewed pull request's body is written once, when it opens, from the step reports ([ADR 0167](0167-a-brewed-pull-request-follows-one-layout-and-opens-as-a-draft-unless-every-taster-approves.md)), and becomes the merge commit's description.
Since [ADR 0219](0219-a-failing-check-on-an-open-pull-request-sends-its-batch-back-to-a-fix-step.md) a failing check sends the batch back and a fix round pushes to the same pull request, so the body can describe a change that is no longer the one that would be merged: "its body is not rendered again (#548)".
The maintainer settled on #274 (2026-10-25 and 2026-10-26) that the body is the change and stays true at merge: "when a review round or a fix changes behaviour, the body is brought up to date", "the body is rendered again on each push".

Four facts shaped it.
A person, or a bot, may edit the body at any time, and that edit is theirs to keep: an overwrite would lose it from the merge description.
The ledger's result for the opened pull request is its URL, a string `openedPullRequest` reads as one in every log.
The order's title and the step reports are read when the effect applies, so the body of a round cannot be rendered again later byte for byte.
GitHub has no conditional update of a pull request: `PATCH /repos/{owner}/{repo}/pulls/{n}` takes no `If-Match`.

## Decision

### The body says it is Foedrum's
- **Every body Foedrum writes ends with a marker line** that names its effect's key and the digest of the text above it, as a status comment's revision does ([ADR 0072](0072-the-status-comment-edits-as-revisions-in-the-ledger.md)): `<!-- foedrum:<key> sha256:<16 hex> -->`, the key `["<batch>","pull_request"]` for the open's body and `["<batch>","body.<n>"]` for round n's (`pullRequestText` given its `key`, `src/engine/pull-request.ts`).
- The digest is the first 16 hex digits of the SHA-256 of the text above the marker, its line endings made `\n` and its end trimmed.
- `pullRequestText` keeps room for the marker under GitHub's limit, so a body cut to length still ends with it.
- **A body is Foedrum's own when its last line is a marker of the batch and the digest of the text above it matches** (`bodyOwner`).
  Only the last line is read, so a marker a brewer wrote into how it works, model text outside a fence, never passes for it: Foedrum's own marker always follows it.
  Line endings are made `\n` first: a person who opens the editor and saves without a change may send `\r\n`, which is not an edit.
- Any other body is left alone, recorded as `edited` when a marker of the batch is on one of its lines (the text changed, the marker moved, a bot appended a summary or ticked a box) and as `unmarked` when none is (every pull request opened before this, or one whose marker a person removed).

### When the body is rendered again
- **A later round's action has a third effect, `["<batch>","body.<n>"]`**, due once the round's push is recorded and went (not `empty`, `refused`, `moved` or `gone`), and while the pull request has no recorded end.
  The driver applies it in the same pass as the push it follows, and ends the action once it is recorded too ([ADR 0071](0071-the-openpullrequest-action-two-effects-of-the-batch.md)).
  Round 1's body is the open's, now with its marker.
- **`find`** reads the body: its last line is this key's marker, so a run before updated it and was killed before the record, and the marker's digest is recorded; otherwise not found.
- **`apply`** reads the body again: Foedrum's own is replaced by `pullRequestText` from the state at apply, as the open renders it (the latest succeeded report of each step, the brew table with the fix rounds), with this key's marker, through `PATCH` with `body` only; any other body is not touched.
- **Its result** (`BodyResult`, `src/schemas/store.ts`) is `{ digest }` for a body it wrote and `{ left: 'edited' | 'unmarked' }` for one it left.
  A read or an update that fails fails the effect, retried as the open's is.
- A kill between the push and the update leaves the key unapplied, so the next pass updates once; a kill between the update and its record finds the marker and records it.

### What the status comment says
- **Under its pull requests, one line when the latest round left the body**: `- <url>: its description was edited since Foedrum wrote it, so Foedrum left it as it is`, or, for `unmarked`, `- <url>: its description has no Foedrum marker, so Foedrum left it as it is` (`renderStatus`).

## Consequences
- After a fix round, the pull request's description says what the fix changed, its reports and its brew table, and the merge commit carries it.
- **The title is not changed**: a person may have renamed the pull request, and the order's title is the same issue's in every round.
- **The draft state is not changed**: making a ready pull request a draft again is a person's call; the draft line is rendered as it is today, so it says what the latest reports say, and a pull request a person marked ready may read "A person reviews this before it is marked ready".
- **A person's edit in the seconds between the read and the update is lost**: GitHub has no conditional update. The window is one request.
- A body a person edited once is never updated again by that batch: every later round finds it not Foedrum's, and says so.
- Every pull request opened before this has no marker and is left alone in its later rounds.
- No schema with a JSON file moves: the ledger's results are not in `schemas/`; an older Foedrum reads a log with a `body.<n>` effect as one it does not apply.
- No merge brief (#551), no conflict route (#547) and no job log (#559) come with it.

## Alternatives considered
- **The digest in the ledger only**: the open's result would change from the URL string `openedPullRequest` reads, breaking every log before it.
- **Compare with the body rendered again from the round before**: the title and the reports are read at apply, so that body is not reproducible.
- **Overwrite always**, as Dependabot and release-please do: a person's edit to the merge description is lost.
- **A body with no marker counts as Foedrum's**: the engine cannot tell it from a person who removed the marker or rewrote the body.
- **Read any marker line, not the last**: a marker a brewer wrote into how it works could pass for Foedrum's.
- **Update the title and the draft state too**: both are a person's to change after the open.
