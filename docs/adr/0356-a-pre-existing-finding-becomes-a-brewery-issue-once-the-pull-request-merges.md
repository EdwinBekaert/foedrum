# 0356. A pre-existing finding becomes a Brewery issue once the pull request merges

Date: 2026-11-08 · Status: Accepted · Amends [0191](0191-the-step-a-findings-route-goes-back-to-records-a-disposition-for-each-finding.md) (who files a pre-existing finding), [0225](0225-a-ready-pull-request-gets-a-merge-brief.md) (what the brief says of one), [0345](0345-a-pull-request-past-a-skip-says-so-and-an-ended-batch-s-status-comment-is-left-alone.md) (what an ended batch's last revision shows)

## Context
When the step a findings route went back to marks a finding `pre-existing` (ADR 0191), the finding was there before the change and the change did not make it worse, so the step does not fix it.
The pull request's reports list it as `to file`, for a person.
Nothing else files it, so once the pull request merges, a defect a Taster found is lost unless a person copies it into an issue.
The maintainer's rule is that a finding never waits for a person (#926), and the maintainer decided that Foedrum files it (#951).

## Decision
### When
- **Once every pull request of the batch merged.** This is the test that closes a Brewery issue (ADR 0296): the batch is on tap and every pull request it opened ended `merged`.
  A pull request closed without merging opens none.
  A claimed batch's findings open Brewery issues too.
- **Only while no revision of the batch's status comment in the ledger has shown its end** (ADR 0345): one rendered after the batch ended, or one from before that record, which says nothing of it.
  A batch that ended before this record has such a revision, so an upgrade opens no issue for an old merge, nor for a batch still on tap whose revisions are all from before ADR 0345.
  The ledger is read, not the fold's `endShown`, which a mark and its recovery clear (ADR 0335).

### Which findings
- **Each finding of a Taster's round that its disposition marks `pre-existing`**, paired as the merge brief and a later round pair them: the first disposition at the finding's place not already taken (`lensRounds`, `withDispositions`, `src/engine/lens-rounds.ts`).
- **A `pre-existing` disposition at a place where no finding is** has no Taster's words, so it opens no issue.
  The pull request's `to file` list still names it.

### The effect
- **One effect of the batch per finding**, `[batchId, "pre-existing.<step>.<attempt>.<n>"]`: the Taster's step, its round's attempt, and the finding's place among that round's findings, counted from 1.
  Every part comes from the log, so a restart builds the same key.
- **Found before it is applied** (ADR 0033), as an approved plan's sub-issues are (ADR 0285): the issue's body ends with the key's hidden marker, and `find` looks for it among the issues, open or closed, that the Brewery's own login opened.
  An open whose answer was lost is found on the next pass, not opened again.
  An issue a person deleted is not found, and is opened again.
- **In the driver's effects, before the status comment's** (`src/cli/driver-wiring.ts`).
  The driver works out the next effect from the state the one before it left, and holds a batch's other effects when one fails, so the status comment's last revision is written only after every issue is in the ledger, and links them all.

### The issue
- **In the Brewery only**, never in the target repository: the text is a model's.
- **Title:** `Pre-existing: <lens>, <severity> in <file>:<line>`, the lens only when the finding has one, as plain text, since GitHub shows a title as it is: a place that looks like a secret is left out, and the title is cut at 200 characters, between characters.
- **Body:** the batch, its order's Brewery issue and the pull requests it merged as, then the step and attempt that found it, the Taster's words, and the words of the step that left it as pre-existing.
  Every model text is shown as the status comment shows one (ADR 0088): a text that looks like a secret is left out, and the rest is escaped as plain text, with no Markdown, HTML or mention.
  The Taster's words and the disposition's are cut at 2,000 characters each, which is the limit on a disposition's `why`.
- **The label `foedrum:pre-existing`**, in the colour of every label Foedrum creates, and no `recipe:` label, so the intake does not order it.
  The body says only that; ordering it is as for any Brewery issue, which the intake takes only from an allow-listed user (ADR 0068).

### The label
- **Made by its effect, before the issue opens**, as the lane labels (ADR 0154) and the recipe labels (ADR 0232) are: a label already there counts as made.
  `foedrum init` makes none of the Brewery's labels, and `foedrum doctor` reads none of them, so neither changes.
  A missing label is never a failure, so `doctor` gets no check for it.

### The links
- **The status comment** shows a section `**Filed**`, after the findings, with one line per opened issue: `- #<n>: <lens>, <severity> in <file>:<line>, there before the change`.
  It is in the merge's own last revision, which ADR 0345 still writes once the batch ended.
- **The merge brief** cannot link the issues: it is posted on the target repository's pull request before the merge, which may be public, and no brief follows a pull request that ended.
  Its line for a pre-existing disposition at a finding's place now ends `, filed in the Brewery once this merges`; one at a place no finding has, which opens no issue, says nothing of it.

### Migration
- A Brewery needs nothing new.
  Its first merged batch with a pre-existing finding makes the label.

## Consequences
- A pre-existing finding is filed without a person, in the Brewery, as an issue no recipe brews until a person gives it one.
- A batch with many pre-existing findings opens as many issues; nothing limits them beyond the 100 dispositions of an out doc (ADR 0191).
- A later recipe that reads these issues and decides where each goes is an idea the maintainer named, not built here.

## Alternatives considered
- **Open the issues when the pull request opens.** Rejected: the change may still be sent back or closed, and the maintainer chose the merge.
- **Key the effect by the disposition instead of the finding.** Rejected: the issue's text is the Taster's finding, and a disposition with no finding has none.
- **Keep the status comment live while an issue is due, through `open` on its revision.** Rejected: the effect order already writes the last revision after the issues, and a second mechanism guards against nothing that can happen now.
- **Read the shown end from the fold's `endShown`.** Rejected: a mark and its recovery clear it on an ended batch, which would let an old merge open issues after the upgrade.
- **A `doctor` check for the label.** Rejected: the effect makes the label, so a missing one breaks nothing.
