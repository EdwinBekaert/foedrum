# Invariants

Property-tested (see [testing](../testing/README.md)):

- **I1** Every non-terminal batch has exactly one pending action with a deadline (for ordered batches: a routing deadline; for conditioning and stuck batches: a reminder deadline).
  A brewing batch runs one attempt, or one per child of a parallel group that has not ended, and its deadline is the earliest of theirs ([ADR 0168](../../adr/0168-a-parallel-group-runs-its-lens-steps-side-by-side.md)).
- **I2** At most one live lease per attempt and per worktree.
- **I3** Replaying the log yields identical state.
- **I4** Every external side effect is keyed `(batch, step, attempt, effect)`, or `(batch, effect)` for an effect of the batch, and applied at most once.
- **I5** A batch past its deadline becomes `stuck` within one supervisor tick.
- **I6** From every reachable state, a terminal state is reachable.
