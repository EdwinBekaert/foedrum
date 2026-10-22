# Invariants

Property-tested (see [testing](../testing/README.md)):

- **I1** Every non-terminal batch has exactly one pending action with a deadline (for ordered batches: a routing deadline; for conditioning and stuck batches: a reminder deadline).
- **I2** At most one live lease per attempt and per worktree.
- **I3** Replaying the log yields identical state.
- **I4** Every external side effect is keyed `(batch, step, attempt, effect)`, or `(batch, effect)` for an effect of the batch, and applied at most once.
- **I5** A batch past its deadline becomes `stuck` within one supervisor tick.
- **I6** From every reachable state, a terminal state is reachable.
