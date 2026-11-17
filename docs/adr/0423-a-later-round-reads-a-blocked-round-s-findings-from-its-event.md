# 0423. A later round reads a blocked round's findings from its event

Date: 2026-11-17 · Status: Accepted · Amends [0191](0191-the-step-a-findings-route-goes-back-to-records-a-disposition-for-each-finding.md) (where a later round's `earlierFindings` reads a blocked round's findings) and [0421](0421-the-engine-marks-a-taster-finding-whose-file-or-line-does-not-exist-at-the-head-it-reviewed.md) (those findings now carry the engine's mark)

## Context
A later round of a Taster's step gets `earlierFindings`, the earlier rounds' findings with their dispositions ([ADR 0191](0191-the-step-a-findings-route-goes-back-to-records-a-disposition-for-each-finding.md)).
A succeeded round's findings came from its event; a blocked round's from the out doc in its worktree, as the route input reads it.
Since [ADR 0421](0421-the-engine-marks-a-taster-finding-whose-file-or-line-does-not-exist-at-the-head-it-reviewed.md), the engine marks a finding whose file or line does not exist at the head the Taster reviewed, in the ending it records; the out doc in the worktree is the Taster's, without the mark.
So a later round read a blocked round's findings without the label every other reader shows, as ADR 0421's Consequences record (#1158).
Every attempt of a blocking Taster blocked by its findings carries them on its ending, and `step.finished` records them (`findings`, [ADR 0221](0221-foedrum-lenses-reports-each-lens-s-findings-their-ends-and-its-tokens.md)), as a group's route lines already read them ([ADR 0349](0349-a-group-s-round-back-carries-every-finding-of-the-round.md)).

## Decision
- **Where:** a later round reads a blocked round's findings from its `step.finished` event, with the engine's marks, never from the worktree (`earlierRoundsOf`, `src/brewers/attempt-plan.ts`).
- **What is kept:** the record's: the first 100 findings, each `file` and `why` on one line and cut to 1,000 characters.
  The input as a whole was already held to 64 KiB.
- **What a round says of the rest:** a last line `<n> more findings were not recorded.` (`1 more finding was not recorded.`) when the event counts more.
- **An event with no findings:** the round says `Its findings could not be read: no findings of it are recorded.`, and claims nothing else of them.
- **What a later round reads of a marked finding:** `- major in src/a.ts:40 (that line does not exist in the reviewed code): …`, or `file`, as everywhere else.

## Consequences
- A later round sees which of a blocked round's findings point at nothing, as the status comment, the pull request and the route inputs do.
- The attempt plan reads no out doc for `earlierFindings`; an out doc the worktree lost, or one a later attempt in the same worktree wrote over, no longer decides what a round is told.
- A finding's `why` past 1,000 characters reaches a later round cut.

### Migration
- None: no file in a Brewery changes, and Foedrum has not been published.

## Alternatives considered
- **Keep the worktree read and copy the marks over by place or order:** it keeps a second source of the same findings and a match that can go wrong, for text the event already holds.
- **Record the findings uncut:** `step.finished` keeps them as the Stuck reason and the route lines read them, and a later round needs no more than they do.
