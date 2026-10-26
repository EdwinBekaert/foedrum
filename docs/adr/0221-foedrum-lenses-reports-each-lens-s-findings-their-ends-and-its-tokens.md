# 0221. foedrum lenses reports each lens's findings, their ends and its tokens

Date: 2026-10-26 · Status: Accepted · Amends [0191](0191-the-step-a-findings-route-goes-back-to-records-a-disposition-for-each-finding.md) and [0192](0192-a-findings-route-that-runs-out-of-rounds-goes-stuck-with-the-open-findings.md) (a blocked round's findings are recorded), [0030](0030-only-commands-that-change-state-are-recorded.md) (one more read-only command) and [0125](0125-the-foedrum-plugin-is-markdown-skills-that-run-the-terminal-with-via-plugin.md) (one more plugin skill); follows [0159](0159-foedrum-brewers-reports-each-brewer-s-attempts-outcomes-stuck-batches-and-tokens.md)

## Context
Every tasting finding gets a disposition (fixed, dismissed with evidence, or pre-existing; ADR 0191, ADR 0204), and every attempt records its tokens. Nothing adds them up per lens, so whether a lens is worth its tokens is a guess (#561).

The ledger does not hold them all. A blocking Taster's `changes` ends as `blocked` with its findings, but `finish` records it as a failure that is not retried, with a reason only; its findings reach the ledger only when the route ran out of rounds (ADR 0192), ten at most. The next round reads them from the worktree's out doc (ADR 0128), which the cleanup removes. The findings a Cellarman fixed are exactly the ones no event keeps.

The events also name a step, never its lens: the lens is in the recipe file (`lens` on a Taster's step, ADR 0161), and a step id is not a lens.

## Decision
- **A read-only command of its own: `foedrum lenses`**, beside `foedrum brewers`, with ADR 0159's shape: it reads the store without a lease, appends nothing, loads the recipe files with the loader the engine uses and is refused with doctor's line when they do not load. Without a store it lists every lens in use with no runs. The plugin carries it as `/foedrum:lenses`, which runs `foedrum lenses --via plugin`.
- **A blocked round's findings go on `step.finished`:** an optional `findings` field, set only for an attempt that ended blocked by findings (a blocking Taster's `changes`), never for a check or another brewer. It holds the first 100 findings (`kept`, as many as an out doc's dispositions), their file and `why` cut as a Stuck reason's open findings are cut (ADR 0192), and a count of the rest (`more`). Each is the Taster's own finding, so a field a finding gains (#560's `lens`) comes with it. An older Foedrum cannot read an event that has it, as ADR 0181 records for receipts.
- **An older event's blocked round** has no recorded findings: the report counts such rounds, and the findings past the 100 kept, on a line of their own, `not recorded`, and never guesses their severity or end.
- **The lens of an attempt** comes from the recipe the batch had chosen when the attempt was scheduled (`recipesRun`) and that recipe's file as it is now (`StepBrewer.lens`), as ADR 0159 finds a brewer. A step the files no longer have, or no longer give a lens, is listed apart by recipe and step, with the same counts.
- **The lenses in use** are those the recipes' lens steps review through: the loaded catalog names them apart (`named.reviewLenses`), since the lenses a brewer input reads (the Gauger's `diff/test-design`) are in use without being reviewed through. Each is listed, in the order of their names, also with no runs.
- **A finding counts once.** Within a batch and a lens step, the rounds run in path order: each attempt that reviewed (a Taster's verdict, or blocked by findings), with the dispositions of the attempt its findings route brought back, or of a retry or an answered attempt continuing that one, paired as ADR 0191 pairs them for the next round (one disposition per finding, by place, the first not taken). A later round's finding at the place of an earlier finding that is still open is the same finding, an advisory lens raising it again, with its latest severity; one at the place of a disposed finding is a contest (ADR 0191) and counts as a new finding.
- **Each finding ends in one of four**: its disposition when it has one (`fixed`, `dismissed` or `pre-existing`); without one, `pre-existing` when the Taster marked it `introduced: false`; else `open` (an advisory lens, the last round, or a batch Stuck). A finding is never counted as both.
- **Severity** is each finding's latest: blocker, major or minor.
- **Tokens** are the sum of `usage` over every finished attempt of the lens's steps, each of the four counts on its own, as `brewers` shows them; an attempt without `usage` adds nothing, and a `resumed` receipt's counts are the session's so far (ADR 0172).
- **The window is every recorded batch**, as `brewers`.
- **A pure function over the folded state** (`lensReport`, `src/cli/lens-report.ts`), given the lenses in use and a step lookup, as `brewerReport`. The rounds of a lens step and their dispositions come from one walk of the batch's path, which the attempt plan's earlier rounds (ADR 0191) use too.
- **Lenses together (#560):** a step that runs several lenses in one Taster gives each finding to the lens it names; its tokens cannot be split, so they show on a row of their own, shared by the lenses it names, and no lens's own tokens include them. Whichever of #560 and this lands second adds that part.

## Consequences
- A maintainer sees, from the terminal or the plugin, how many findings each lens raised, how bad, how they ended, and what the lens cost, at no cost: no model call, no lease, no event.
- `step.finished` of a blocked Taster grows by its findings, at most 100 of at most 1,000 characters' file and `why` each.
- Rounds recorded before this change count on the `not recorded` line; the counts become complete as new batches brew.
- A recipe file edited between batches changes which lens an old attempt counts for when a step keeps its id and names another lens, as for brewers.

## Alternatives considered
- **`foedrum status --lenses`.** Status is the board of live batches, and its lines are changing under #563 and #546.
- **`foedrum replay`.** One batch's log, not a sum over batches.
- **A section of #392's report.** Not built; it can link to this one.
- **Count from the Cellarman's dispositions alone.** A disposition has no severity, and a finding nobody disposed of would vanish.
- **Read the worktree's out doc.** Gone after the cleanup.
- **A new event for a round's findings.** #561 rules it out; the attempt's own `step.finished` is where its ending is recorded.
- **Cut at ten, as a Stuck reason does.** Findings past ten would lose their place, and their dispositions could not be paired.
- **Record the lens on `step.started`.** Old events would still need the recipe (ADR 0159).
- **The step id as the lens.** Nip's `correctness` step reviews through `diff/correctness` today, but an id is a name a recipe chooses, not a lens.
- **A `--since` flag or the last N batches.** Not until someone asks for one.
