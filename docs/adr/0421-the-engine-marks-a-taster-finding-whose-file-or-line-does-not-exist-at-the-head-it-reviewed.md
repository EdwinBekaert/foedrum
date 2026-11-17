# 0421. The engine marks a Taster finding whose file or line does not exist at the head it reviewed

Date: 2026-11-17 · Status: Accepted · Amends [0161](0161-lens-steps-run-a-taster-whose-findings-are-advisory-unless-the-step-blocks.md) (what the engine reads of a Taster's findings) and [0128](0128-an-attempt-a-route-schedules-gets-what-sent-it-back.md) (a blocking Taster's route input names its findings whose place does not exist)

## Context
A Taster's finding names a `file` and a `line` ([ADR 0161](0161-lens-steps-run-a-taster-whose-findings-are-advisory-unless-the-step-blocks.md)), and the engine never checked that they exist at the head the Taster reviewed.
The findings reach the status comment, the pull request, the merge brief and, on a findings route, the input of the brewer it brings back.
Models cite wrong lines: in #104, reviewers cited lines 27 and 34 of a 20-line file, which is why `/brew-review` checks every citation (`scripts/citations.ts`).
Issue #816 asks the engine to do the same; on 2026-11-17 the maintainer settled that a finding whose place does not exist is kept and labelled, not dropped, not a failed attempt, and the Taster is not sent back.

## Decision
- **Where:** once a Taster's attempt ends, done or blocked by its findings, the claude runner reads each file its findings cite at the commit its worktree started at, the head it reviewed, in the repository's clone (`git ls-tree` with literal pathspecs, then `git cat-file blob`), never the worktree, which the brewer can write (`placesChecked`, `src/engine/finding-places.ts`; `readFilesAt`, `src/workspace/finding-files-git.ts`).
  Only a Taster of a change in its own repository's worktree gets a tree (`reviewed` on its attempt plan): a plan lens's Taster reviewed a plan, not a head, and a Brewery order's attempt of several checkouts has no one tree.
- **Which check:** `/brew-review`'s citation check, moved to `src/checks/citations.ts` so the engine and `scripts/citations.ts` share it: a plain relative path, and a line no further than the file's last, a final newline starting no line.
- **What a finding gets:** `missing: 'file'` when its path is no plain path or no regular file at that commit (missing, a folder, a link or a submodule; a path in another letter case is missing too, on every file system, as `/brew-review`'s check has it, since git's tree is case-sensitive), `missing: 'line'` when its line is past the file's end, nothing otherwise; a finding with no file, or a file and no line that exists, is not marked.
  A line 0 cannot happen: the out doc's schema takes only a positive line.
- **Whose mark:** the engine's. A Taster's out doc that sets `missing` is invalid (`TastingOutDoc`); the engine reads its own stored output with `StoredTastingOutDoc`.
- **When git cannot read the files,** no finding is marked: nothing is claimed of a file that was not read, and the attempt ends as it would have.
- **What a person reads:** after the place, `(that line does not exist in the reviewed code)` or `(that file does not exist in the reviewed code)`, through `missingNote` (`src/schemas/out-doc.ts`): in the status comment, `foedrum stuck`, the pull request and the merge brief (`findingText`), and in a later round's and a group's route lines; a blocking Taster's route input, which quotes its out doc as written, adds `Of its findings, these cite a place that does not exist in the reviewed code:` with each marked finding.

## Consequences
- A person and the brewer a route brings back see which findings point at nothing before they act on them; no finding is lost to a wrong line.
- A Taster's attempt runs one `git ls-tree` and a `git cat-file` per cited file more, in the clone, with no model.
- A finding gains an optional `missing` (`schemas/event.json`); an older Foedrum cannot read an event log that holds one.
- A later round's `earlierFindings` input reads a blocked round's findings from its out doc in the worktree (`earlierFindingsFor`, `src/brewers/attempt-plans.ts`), so those carry no mark; a succeeded round's do.

### Migration
- No file in a Brewery changes: next to a finding whose line does not exist, a person now reads `(that line does not exist in the reviewed code)`.

## Alternatives considered
- **Send the Taster back once to correct the place,** as `/brew-review` does: it costs a session per wrong citation, and the maintainer chose the label.
- **Drop the finding:** a real defect cited at the wrong line would be lost.
- **Read the worktree:** the brewer can write it, and a later attempt may have changed it; the commit in the clone is what was reviewed.
