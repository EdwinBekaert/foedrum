# Invariants

Property-tested (see [testing](../testing/README.md)):

- **I1** Every non-terminal batch has exactly one pending action with a deadline (for ordered batches: a routing deadline; for conditioning and stuck batches: a reminder deadline).
  A brewing batch runs one attempt, or one per child of a parallel group that has not ended, and its deadline is the earliest of theirs ([ADR 0168](../../adr/0168-a-parallel-group-runs-its-lens-steps-side-by-side.md)).
- **I2** At most one live lease per attempt and per worktree.
- **I3** Replaying the log yields identical state.
- **I4** Every external side effect is keyed `(batch, step, attempt, effect)`, or `(batch, effect)` for an effect of the batch, and applied at most once.
- **I5** A batch past its deadline becomes `stuck` within one supervisor tick, except an attempt that has not started while a person's pause holds its batch ([pause and continue](../humans/pause.md)); an attempt that has not started while any usage window is closed waits for a window's reopen, its deadline, which gives it a new one ([the usage window](usage-window.md)).
  The wait for the checks on an open pull request's head has no deadline, a written exception to "every wait has a deadline" beside a person's pause and a blocked sub-order ([ADR 0211](../../adr/0211-the-intake-starts-ready-sub-orders-at-their-order-s-rank-once-their-blockers-merged.md)): its batch is On tap, and its status comment says since when it waits ([open pull requests](../intake/open-pull-requests.md), [ADR 0213](../../adr/0213-an-open-pull-request-s-checks-on-its-head-are-recorded-once-they-finish.md)).
- **I6** From every reachable state, a terminal state is reachable.
