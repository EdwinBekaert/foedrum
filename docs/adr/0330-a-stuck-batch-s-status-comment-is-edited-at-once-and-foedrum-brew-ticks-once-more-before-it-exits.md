# 0330. A Stuck batch's status comment is edited at once, and `foedrum brew` ticks once more before it exits

Date: 2026-11-06 · Status: Accepted · Amends [0072](0072-the-status-comment-edits-as-revisions-in-the-ledger.md) (which revisions are due at once) and [0275](0275-a-finished-plan-waits-stuck-for-its-review-and-every-comment-links-the-doc-it-sums-up.md) (the one tick more after a batch sticks is no longer only a plan's)

## Context
In the self-brew trial (#374, #863), batch `foedrum-855` went Stuck at 17:01:15. Its label became `foedrum:stuck`, while its status comment, last edited at 17:00:35, still read Brewing with `survey` running and had no `Next:` line. It caught up only when the next run started.

Two paths leave the comment behind when `foedrum brew` exits, and tests through `runBrew` on the fake host show both:

- **The minute limit.** ADR 0072 lets a batch's revision through within a minute only for a first revision or an ended batch, and ADR 0275 added a plan to review. Any other Stuck within a minute of the last edit has no revision due, and `foedrum brew` exits on reading Stuck. The trial's edit was 40 seconds before its Stuck. The lane label has no such limit. `foedrum serve` hides this, since it keeps ticking.
- **A Stuck recorded after the pass asked.** A driver's effect pass ends each batch by recording the end of its actions (`finishActions`, `applyBatch`). A push the secret scan refused, or one with nothing to push, ends `openPullRequest` blocked or failed there, so the batch goes Stuck after the pass last asked what is due. Lifting the limit does not reach this path: with only that change, the test of a refused push still fails.

An attempt's end and a supervisor's `expire` meet only the first: a tick runs the supervisor, then the drive that records attempts' ends, then the effects, so the revision goes in that tick once the limit lets it.

## Decision
- **Every Stuck batch's revision is due at once**, whatever its reason (`statusEffects`). A Brewing, Ordered or Conditioning batch stays at one edit a minute.
- **`foedrum brew` ticks once more after any Stuck but `needs_input`**, not only after `plan_review`, and only then says its last line and exits (`runBrew`). `needs_input` returns first: only an attempt's end asks questions, and the tick records that before it applies effects.
- **Nothing starts in that tick.** The drive starts only a Brewing batch's attempts and effects run an action only while it runs, so a Stuck batch starts no session and tries no action again.
- **The loop reads what that tick left.** The lane is read again and goes through the same `switch`, so a person's `retry` that lands in between goes on brewing, and no Stuck line is said from a state that has moved.
- **A failure in that tick is said as any other.** A revision that fails is reported on its own line (`effect_failed`), and the exit is still Stuck (3): the comment catches up at the next run. A tick that throws is reported too (`tick_failed`) and the exit is still Stuck. Only `StateBranchStopError` changes the exit, to 1 with its message, as in any tick of a brew: the engine must stop, and the batch stays Stuck in the store.

### Why any Stuck cannot defeat the limit
The limit protects GitHub's secondary limits from a stream of edits (ADR 0072).

- **A batch reaches Stuck at a person's pace.** It enters from a decision about an attempt, a deadline, a routing deadline or a pull request out of rounds, and it leaves only by a person's command (`retry`, `answer`, `skip`, `recipe`, `rewind`, `approve`, `lauter`). So after its first, each further Stuck costs a person's command.
- **A reminder changes no text.** A `remind` repeats `batch.stuck` with a new `remindAt` every two days, and the text never holds a reminder's time (ADR 0072), so its digest is the same and no revision is due. A test pins this.
- **Nothing that streams reads a Stuck batch.** The checks on a pull request are read for a batch on tap, which already edits at once (ADR 0072).

## Brewery migration
Nothing to do. No file of a Brewery changes, and a comment an earlier version left stale catches up on the next run that holds its batch.

## Consequences
- A person reading the comment at the end of a `foedrum brew` sees the Stuck lane and its `Next:` line.
- Each `foedrum brew` that ends Stuck runs one more supervisor tick, drive and flush, with no pause before it, and may make one more edit.
- A state branch that says stop during that tick now shows as exit 1 instead of a Stuck exit, one tick sooner than the next run would have met it.

## Alternatives considered
- **Run `applyBatch`'s effect loop again after `finishActions`:** the pass would be whole for every driver, but this is the path every batch takes on every pass (#867), and `foedrum serve` already catches up at its next tick; only the exit of a brew needs it.
- **Lift the limit only for the first revision of each Stuck:** an edit less while a batch sits Stuck, but a further piece of driver memory beside the last edit's time, for text that does not change there.
- **Keep the extra tick for `plan_review` and post from `foedrum brew` at exit:** a second way to apply an effect, outside the driver's pass and its lease.
