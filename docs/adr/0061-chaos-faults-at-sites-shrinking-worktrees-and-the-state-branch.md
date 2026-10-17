# 0061. Chaos faults at their sites, shrinking, and the worktree and state branch cases

Date: 2026-10-17 · Status: Accepted · Amends [0037](0037-attempt-worktrees-in-the-engine-and-driver-locks.md) (when a driver cleans an ended batch's worktrees) and [0051](0051-chaos-runs-on-the-real-driver-with-two-drivers-and-a-terminal.md) (how the harness decides its faults, and what it covers)

## Context
[ADR 0051](0051-chaos-runs-on-the-real-driver-with-two-drivers-and-a-terminal.md) left three things for #144: the worktree cases of [ADR 0037](0037-attempt-worktrees-in-the-engine-and-driver-locks.md), the state branch ([ADR 0011](0011-state-in-the-brewery-repository.md), [ADR 0024](0024-state-branch-layout-outbox-and-divergence.md)), and shrinking a failing run.

The harness drew every fault from random streams of the run's seed, one draw per kill point and per decision, counted over the whole run. When #150's session tried to shrink a failing run, nothing was left: removing any move shifted every later draw, so every later kill landed elsewhere, and with no kills the seed's scenario passed. They built the smallest schedule by hand instead.

## Decision

### Faults are decisions at sites
- Every fault a chaos run can have goes through one interface, `Faults` (`test/helpers/chaos.ts`): a kill at a kill point, the turns a call to the code host lets the other drivers run, the driver that plays a move first, a killed driver kept down, a live driver stalled, a terminal command mid-tick.
- Each decision is made at a **site**: the move, by its number in the run as first played; the driver; and how many decisions of that kind for that driver came before it in that move. A run notes each decision other than the quiet one (no kill, no pause, no stall) as a `Fault` at its site.
- A run as first played draws its faults from the same random streams, in the same order, as before, so every seed plays as it did. A run replayed from a list of faults has exactly those faults, at their sites, and the quiet decision everywhere else. Replaying a run's own list reproduces it event for event.
- The ticks that let the batches come to rest count on from the number of the last generated move of the run as first played, so their faults keep their sites when earlier moves go too.

### A failing run shrinks to a smallest schedule
- A schedule is a run's moves (each with its site), its plays and its faults. `checkSeed` (`test/helpers/chaos-shrink.ts`) runs a seed; when it fails, `shrinkChaos` removes chunks of moves, then chunks of faults, halving the chunk size down to one, again and again until neither shrinks. Then it makes each play that is left a success where that still fails. Every candidate is a replay on a database of its own.
- Removing a move takes only that move's own faults with it. Every other fault stays at its site, so the faults a failure needs stay where they did their work. A site the shorter run never reaches has no fault, and the faults a run did not reach are dropped from the schedule.
- A candidate counts only when it fails the same way: the same error name and first message line, with every number in it left out, because a smaller run names other batches and attempts. Any failure would let shrinking drift into another bug, such as a run that never comes to rest.
- Shrinking replays at most 250 runs and says so when it runs out. The report gives the seed (which `FOEDRUM_SEED` replays), the size before and after, the faults left at their sites, the moves left by their numbers, the plays left, and the shrunk run's kills, moves and events.
- The shrunk schedule is a local minimum: no single move or fault can go. It is not always the smallest schedule there is, but it keeps the faults the failure depends on.

### The worktree cases
`test/chaos/worktrees.test.ts` gives the driver an in-memory clone (`test/helpers/chaos-worktrees.ts`): git's worktree records, the attempt folders and the attempt branches, which outlive every driver process. Its manager decides through the real `planWorktree` and `planClean` and carries a plan out one git step at a time. It has three kinds of kill point of its own: while it makes a worktree (after the branch, after the record), after it made one and before the driver records it, and while it cleans (before each step, and between a removed folder and its record). The terminal sometimes cancels a batch while an attempt of it runs; the generated scenarios rarely do. The checks:

- no attempt starts without its worktree on its branch;
- nothing of a live batch is removed, and no worktree, folder or branch of an attempt that is still running (an attempt whose live driver's runner still reports progress for it);
- at rest, nothing is left of an ended batch, and nothing of a batch the state does not know.

The checks define "ended" themselves (on tap or cancelled), not through `laneStatus`, so a defect there cannot change what they check. A second test searches seeds from 1 until the runs reach every case of ADR 0037: a kill while a worktree is made, a kill between making and recording it with the next start reusing it, a kill while cleaning, a crash's leftovers of an ended batch removed by the next start's repair, and a batch that ended while an attempt ran, whose worktree was kept and removed later.

### The state branch cases
`test/chaos/state-branch.test.ts` gives every driver process an in-memory state branch (`test/helpers/chaos-state-branch.ts`): the state worktree's files, its local commits and the remote, which outlive the processes. A process starts on it before it opens its driver, and its supervisor flushes it. The model does what the shell does at a start and at a flush, in the same order. The pure core decides (`decideStart`, `planFlush`, `mergeLogs`, `planCatchUp`), and the store keeps the pushed-through marker. Kill points: while it writes the log files, before the push reached the remote, and after it did but before the marker was written. The checks:

- after every move, the remote holds the store's first events, each once, as the store has them;
- the marker names a commit on the remote and no event beyond the remote's last;
- no start stops the engine or restores, and each start leaves what was committed before it on the remote. `decideStart` flushes whenever events are unpushed, also before the remote branch exists, where that flush is the first one, which creates the branch (ADR 0024's start table: "run; the first flush creates the branch");
- after a tick the drivers lived through, the remote holds what was committed before that tick;
- at rest, one more flush pushes every event.

One driver runs these cases. Two drivers of one machine would flush through one state worktree, and how two processes share it is settled neither by ADR 0024 nor by [ADR 0044](0044-batch-leases-held-by-the-driver-and-one-command-log.md), so the harness does not guess at it. The shell's git calls are what the state branch's integration tests cover.

### A driver cleans an ended batch again once no lease of it is alive
The worktree runs found a gap in ADR 0037. A batch cancelled while an attempt runs is cleaned at once, and that cleanup keeps the attempt's worktree under its live lease. A run that ends lets its lease go, and the driver cleans again then. A run whose process died with the runner never ends: its lease is no longer renewed and expires, and nothing cleaned the batch until the driver's next start. Now a driver notes a batch whose cleanup runs while a lease of it is alive, and cleans it again on a drive once none of its leases is alive. It asks before the cleanup reads its claims, since a lease the cleanup keeps a worktree for may expire while its git steps run; an ended batch gets no new lease, so asking early misses none. So the worktree goes once that attempt's lease does, as ADR 0037 has it.

## Consequences
- A failing chaos run in CI or the nightly run reports a short schedule with its seed. With #150's bug planted again, its seed 1348138455 shrinks in 125 runs from 20 moves and 31 faults to 13 moves and 10 faults. The kills left are in the moves #150's report named. Before, shrinking kept nothing.
- Each new case is in a file of its own, under the 15 s ceiling of [ADR 0036](0036-test-budget-in-cpu-time.md) (each takes 2.5 to 3.5 s of CPU time in `npm run check`), and runs `FOEDRUM_RUNS` seeds like `restarts.test.ts`. Each was shown red on defects planted in `src/` (#144's pull request lists them).
- What the harness still does not cover: the real runner's processes, a second process of a live driver (ADR 0051), two drivers flushing one state worktree, whose design is open, and the intake killed between `order` and `route`, which #142 covers. The models keep what a crash leaves simple: a checkout is whole or not there, and a worktree a crash left half checked out, with changes, is not modelled. That case is kept by design (a worktree with changes stays).
- `ChaosChecks.atEnd` may be asynchronous, and `ChaosOptions` can carry the faults to replay, a clone, a state branch, and the moves a seed plays.

## Alternatives considered
- **Shrink by kill-point counts over the whole run, as drawn:** what #150's session tried. Removing a move moves every later fault, and the shrunk run keeps none of them.
- **Record every decision, the quiet ones too, and remove them:** a run makes thousands of quiet decisions, and removing one of them is the same as keeping the quiet one, so the list of faults that fired is the same search space with less to try.
- **Keep any failure while shrinking, as the property tests do:** a smaller run may fail some other way, a run that never comes to rest for one, and the report would no longer show the bug that was found.
- **Run the real shells against a fake git:** the worktree manager and the state branch shell are tested against real git in `test/integration/`. A fake git good enough for them would model git, not the crash windows, and would cost more CPU time than the 15 s ceiling leaves.
- **Clean an ended batch on every tick until nothing is left:** simpler, but it would run a cleanup per tick for a batch whose worktree is kept for good, one with changes, for example. Cleaning again once no lease of the batch is alive runs it once more, when what kept the worktree is gone.
