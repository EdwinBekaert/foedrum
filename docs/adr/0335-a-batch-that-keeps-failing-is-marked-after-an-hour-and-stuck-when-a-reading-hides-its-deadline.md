# 0335. A batch that keeps failing is marked after an hour, and Stuck when a reading hides its deadline

Date: 2026-11-06 · Status: Accepted · Amends [0327](0327-a-pass-over-one-batch-s-effects-that-throws-stops-no-other-batch.md) (a batch whose effects throw on every pass is marked, and its other sources' effects still apply), [0328](0328-one-batch-s-error-stops-no-other-in-the-supervisor-or-the-drive.md) (what a person sees beyond the driver's line, `effect_failed` and the supervisor's `command_failed` said once, and a message compared without its numbers), [0250](0250-the-supervisor-is-one-tick-the-commands-own-the-interval.md) (a tick ends by settling what failed), [0072](0072-the-status-comment-edits-as-revisions-in-the-ledger.md) (the status comment shows the mark) and [0099](0099-a-rejected-run-end-is-blocked-on-the-environment-not-a-failed-tick.md) (a summary also ends at a line or paragraph separator)

## Context
After ADR 0328, one batch's error stops no other batch, and the driver says it once.
That line in the driver's output was the only sign, nobody may be reading that terminal, and CLAUDE.md says a batch must never sit silently.
A failure in the supervisor can also hide an attempt's deadline, so a brewing batch could run past it unseen.
`combineEffects.due` was a `flatMap` over its sources, so one source that throws took the status comment and the labels down with it, and the status comment could not say so.
`foedrum status` reads the fold, so a person can see this there only if it is an event.

## Decision

### The mark
- **A batch whose passes have failed for an hour is marked**, as `batch.failing` with the pass it failed in last, a summary of at most 120 characters (the first line, as ADR 0099 has it) and since when.
  The mark is a field of the fold and changes no lane. A clean pass records `batch.recovered`, and the mark goes.
- **The hour is one clock per batch, across its passes**, in the driver's memory, as the flush watch's is (ADR 0027), so a restart can make the mark later, never sooner. It counts from the first failure this driver saw.
- **It starts again** after a tick that reached its end with no failure on the batch, and at a person's way out of a Stuck on failing. A tick that rejects (`tick_failed`) resets nothing and marks nothing.
  The time a machine sleeps between two failures counts: the batch failed before the sleep and after it, so the claim is still true.
- **What counts:** a throw for the batch in a pass (`batch_failed`, `batch_effects_failed`), a supervisor's command for it that throws (`command_failed`), and an effect of it that fails (`effect_failed`).
  An attempt's end whose record throws does not: each end comes once, and the supervisor loses that attempt.
- **Who writes it.** A driver that may hold the batch, in the transaction that takes or renews its lease, at the end of its tick, each mark under a guard of its own.
  A driver that does not take the batch records nothing, though its supervisor still says the line of a free one. Two drivers cannot both write: the second finds the first's lease and records nothing.
- **`decide` and `admit` refuse** a mark of a batch never ordered, a second mark, and a recovery with no mark, rather than throwing. Every lane takes the mark, cancelled too: a cancelled batch whose effects throw stays held, and its claim's release may be what waits.
- At most two events per batch per hour, which bounds what a failing batch adds to the log.

### Stuck
- **A brewing batch whose readings have failed for an hour goes Stuck**, with the new reason `failing`, in the decision that marks it: its attempt's deadline may not be readable.
  Its reason names the first running attempt's step, read from the fold, since the recipe may be what throws.
- **An effect that fails marks and never makes a batch Stuck.** It leaves the deadline readable, and an hour's outage of the code host must not stick every brewing batch. So the reading has a clock of its own beside the batch's: 30 minutes of a failing effect and 30 of a failing reading mark the batch and do not stick it.
- **A brewing batch with no running attempt carries only the mark**, until an attempt exists: a retry would have nothing to schedule.
- **An interactive step's open session carries only the mark**: a person is at work, as ADR 0222 has it, and Stuck would stop their session.
- **A batch marked in another lane that later brews goes Stuck** at the next end of a tick, with no second mark.
- **No other lane goes Stuck.** On tap, the records of a pull request's checks and its merge still go through, and its Brewery issue still closes: allowing Stuck from there would refuse them, and `batch.resumed` never returns a batch to on tap.
- **`failing` offers what `stalled` offers.** `retry` schedules its step again with a new deadline, and its group's other children, as for any Stuck.
  Every person's way out of it (`retry`, `skip`, `recipe`, `rewind`) takes the mark off, and the driver's hour starts again, so a batch still failing is marked and Stuck again an hour later, not at once.
  A way out of any other Stuck leaves the mark to a clean pass.
- **While Stuck on `failing` no recovery is recorded.** Stuck reads too little to call a tick clean, so the mark would go five seconds after it came.
- **A person's command whose reading of the recipe throws** says which batch and what failed, in one line, and that `cancel` and `recipe` still work: `retry` and `skip` read the recipe.

### The sources stay apart
- One source of effects that throws leaves the others' effects due, and the pass fails at its end, naming the first error.
  `combineEffects.due` reads every source and then throws `UnreadSources`, carrying the keys it could read, so anything that reads it as a plain throw sees "not all known": `recordAfter` records nothing and `noneDue` lets nothing go.
  Only the pass over the batch's effects unpacks it, applies those keys and throws it again before it finishes actions or records anything.
- **When `planIssues` is the source that throws**, the status comment, the labels and the plan comment are written first, without the sub-issues' numbers, no sub-issue is opened, and no `order.decomposed` is recorded. Once it reads, its issues open and both comments come to name them, since a changed text is a new revision. No close is due meanwhile: a split order's needs its breakdown recorded.

### A person sees it
- `foedrum status`, `foedrum stuck` and the status comment show the mark: what failed and since when, never blaming the batch, since an outage fails it too.
- Where the status comment's own source is the one throwing, the comment cannot show it, and `foedrum status` still does.
- `foedrum status`, its order's board, `--watch` and `foedrum stuck` read each batch under a guard: a batch whose rendering throws is shown with its id, its lane, its mark and `cannot be read`, and the others are unaffected.
- `foedrum stuck` also lists the marked batches that are not Stuck, which no other line there shows.

### What is printed
- `effect_failed` and the supervisor's `command_failed` come under ADR 0328's line: said once per effect or per command and batch, until the message changes or a pass no longer fails on them.
- A message is compared with its runs of digits folded, so a time or a count in it does not say it again each pass.
- A summary also ends at a line or paragraph separator, so what it quotes cannot forge a line of `foedrum status`.

## Consequences
- ADR 0328's exception to "a batch must never sit silently" shrinks to one case: a batch whose status comment's own source throws, where the comment cannot show the mark and `foedrum status` still does. The `CLAUDE.md` line says so.
- A batch's reading that fails for less than an hour still has only the driver's line. So does one whose driver does not take it: with no Cellar running, a free batch is marked by nobody.
- An hour's outage of the code host marks each batch with an effect due, and clears them at the next clean pass.
- A paused batch and one a closed usage window holds are not read by the drive, so a failure only there is recovered, as ADR 0328 said of its line; its mark comes an hour after it fails again.

## Migration
None in a Brewery's files, and a Brewery need do nothing. A running Brewery reads the added events on restart. A batch's hour starts again there, and a mark already recorded stays until a clean pass.
An older Foedrum cannot read a state branch that holds `batch.failing`, `batch.recovered` or a Stuck reason `failing`, as with any added event.

## Alternatives considered
- **Stuck from on tap:** rejected by the maintainer. `checkable` and `endable` would refuse the records of its checks and merge, its Brewery issue would never close, and `retry` has nothing to schedule. Allowing it means about 200 to 250 lines in the state machine, on the merge path.
- **The hour in the event log:** a failure that is only printed would add an event each tick, or a read of the log, for a time only this driver acts on.
- **A plain guard per source:** `recordAfter` and `noneDue` read "nothing pending" as "all done", so `order.decomposed` would be recorded after an unread `planIssues`, and the batch let go.
- **An effect that fails counts for nothing:** an effect that fails for a reason of its own batch would have only the terminal's line, which is what this decision ends.
- **An effect that fails counts for Stuck too:** an outage would stick every brewing batch with an effect due, though each deadline is still readable.
- **Recording a recovery while Stuck on `failing`:** see above: the mark would last one tick.
