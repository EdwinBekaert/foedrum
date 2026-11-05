# 0327. A pass over one batch's effects that throws stops no other batch

Date: 2026-11-05 · Status: Accepted · Amends [0250](0250-the-supervisor-is-one-tick-the-commands-own-the-interval.md) (a throw in the pass over one batch's effects no longer reaches `tick_failed`)

## Context
A batch's folded steps keep the attempts of every recipe it brewed, and a recipe throws when asked about a step it lacks.
In the self-brew trial (#374, #867), a batch mashed to a building recipe made the merge brief's reading throw on `innkeep`, on every tick once its pull request's checks finished.
The driver's pass over the batches had no guard around that reading, so the pass rejected, the later batches had no effects applied, and `foedrum serve` printed `a tick failed` every 5 seconds without naming the batch.
`foedrum brew` of another order printed it too, since a driver reads every batch's due effects, and that order's Brewery issue did not open.
ADR 0250 has each command report a tick that throws as `tick_failed` and run the next one, which said nothing of one batch's share in that throw.

## Decision
- The driver's pass over a batch's effects (`applyBatch`, under `applyPass`) runs under its own `try`.
  A throw outside any one effect is reported as the notice `batch_effects_failed`, naming the batch, and the pass goes on to the next batch.
  A throw while applying one effect stays `effect_failed`.
- The `try` takes all of that pass: reading what is due, renewing the leases, ending the action attempts and recording what the effects call for. A fault of the store there is reported against the batch being visited, and the tick's own uses of the store, which have no such guard, report it as `tick_failed`.
- The throw itself records nothing. What the pass recorded before it stays, an effect it applied among them, and the next pass goes on from there, so a reading that recovers applies the batch's other effects then.
- The tick lets go of an ended batch only once it has no effect due. One whose due effects cannot be read counts as not finished: it stays held, and the other ended batches are let go. A batch on tap counts as ended, so this is the case #867 reported. The pass over its effects has already said why.
- A `StateBranchStopError` still stops the engine through `tick()`, as ADR 0250 says: it comes from the state branch's start and the supervisor's flush, and neither runs in this pass.
- This amends ADR 0250 for that pass only. A throw elsewhere in the tick, in the supervisor or the drive, still rejects the tick and is reported as `tick_failed`, without naming a batch.
  The maintainer narrowed #867's "one batch's error never stops another's work" to this pass: the supervisor and the drive are #870's, an open issue, which will also take how often the notice repeats.

## Consequences
- One broken batch no longer stops the effects of the others, or the release of other ended batches.
- A batch whose effects throw on every pass has no deadline and never goes Stuck, and its status comment and labels wait too, since they are effects of the same reading.
  The line in the driver's output is its only sign, repeated on every pass, so such a batch can sit unnoticed where nobody reads that output.
  This is the one place this decision leaves CLAUDE.md's rule that a batch must never be able to sit silently unmet; before it, the same batch stopped every batch instead.
- A driver that does not hold the batch reports it too, since a driver reads every batch's due effects before it claims one.
- No Brewery needs a migration: no file a Brewery holds changes, no event is added, and the notice is only printed, never stored.

## Alternatives considered
- **Guard only the reading of what is due:** rejected. A throw from ending an action or from recording what the effects call for would still stop the later batches, which is what #867 asks to end.
- **Keep `tick_failed` for a store fault, by catching only errors of a batch's own:** rejected. Nothing tells the two apart at the catch, and a fault of the store also fails the tick's own uses of the store.
