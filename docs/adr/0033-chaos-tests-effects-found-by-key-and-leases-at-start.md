# 0033. Chaos tests: effects found by their key, and a driver's leases at its start

Date: 2026-10-16 · Status: Accepted · Amends [0024](0024-state-branch-layout-outbox-and-divergence.md) (leases after a restart on the same database)

## Context
M0 ends with 1,000 chaos runs that kill the engine at random points and restart it: no lost or duplicated side effects, no silent stalls (#15). Three things were open.

- The idempotency ledger (invariant I4) records an applied effect, but nothing applied one, and a ledger alone cannot keep an effect at most once across a kill: an engine killed after the code host made the comment and before the ledger recorded it would make it again when it restarts.
- Leases live in the database, so a restart on the same database finds the leases of the run that was killed. [ADR 0024](0024-state-branch-layout-outbox-and-divergence.md) says leases mean nothing after a crash, but nothing acted on that. The first chaos runs found the cost: a lease left on an attempt that Stuck had abandoned stays live for up to its 5 minutes, and a human's retry in that time runs a second attempt of the step beside it, which breaks I2.
- Unit, property and chaos tests start no processes ([ADR 0021](0021-unit-tests-spawn-no-processes.md)), and the engine is not a program yet, so "kill the engine" needs a meaning that does not kill a process.

## Decision

### An effect is found by its key before it is applied
- `applyEffect` (`src/engine/effects.ts`) answers from the ledger when the key is recorded; otherwise it asks the effect's target for the key, and applies the effect only when the target does not have it; then it records what it got. When the target fails, nothing is recorded and the next run asks again.
- So every effect target finds an effect by its key: the key travels with the effect (a hidden marker in a comment's or pull request's body, a pull request's head branch, a label that is either there or not). The GitHub layer provides this for each effect it adds.
- **Only Foedrum's own objects count.** Keys are predictable (an issue number, the recipe's step ids, small attempt numbers), and anyone who can comment on an issue or open a pull request from a fork could plant one. So `find` matches only what Foedrum's own authenticated identity made: comments and pull requests by its app or bot user, and branches in the Brewery's or target's own repository, never a fork's. Anything else that carries a matching key is ignored and reported. Otherwise a planted key would suppress the effect, and the ledger would record the planter's object as Foedrum's, for later steps to act on.
- A target checks what it returns (found or applied) against the effect's schema, and fails, recording nothing, when it does not match: the result comes from outside the process, and the ledger keeps it for good.
- Calls of `applyEffect` for one key must not overlap: both would find nothing on the target and apply the effect. A driver applies the effects due one pass at a time.
- Every effect is due because of recorded events (a succeeded attempt, a batch on tap), never because of something only the engine's memory knew, so a restarted engine finds it due again with the same key.
- The ledger is written through the command layer (`decide`'s `record` and the guard), like any event.

### A driver that starts expires the leases of its earlier run
- When a driver starts on a store, it sets the leases its own owner holds to expire now. Its processes died with it (architecture §5: on restart there is no "maybe alive"), so the supervisor's next tick loses their started attempts and retries them ([ADR 0027](0027-supervisor-lost-and-stalled-attempts.md)), and releases the others; no new attempt of a step runs beside one of them.
- A driver's owner is stable across its restarts and its own: a driver expires only its own leases, never those of another driver that may still run. `expireOwnLeases` (`src/engine/leases.ts`) does it; the test driver (`test/helpers/brewing.ts`) calls it in `start()`, and the real drivers (#37) must call it when they start.
- This refines ADR 0024's "leases are not rebuilt": a restart on the same database keeps them only until the driver starts.

### Kills in the chaos harness
- The harness (`test/helpers/chaos.ts`) plays the generated engine scenarios of the property tests (#14) on an SQLite file. A kill is an exception the engine cannot catch: once thrown, everything the dead engine touches throws too. The harness then closes the database and starts a new driver, supervisor and fake runner on the same file; the attempts that ran die with the old runner. What survives is the database and the fake code host.
- Kill points: before every write in a transaction (the store rolls the transaction back, as SQLite does for a process that died with it open), after every commit, and on both sides of an effect reaching the code host. Each kind has its own chance per point, from a random stream of the run's seed, at most six kills per run, so kills spread over the whole run and reach the narrow windows around an effect.
- `synchronous` is off in the harness: a kill ends a process, not the machine, and what SQLite handed the operating system survives it. Power loss is not simulated.
- Checks: after every move, at most one live lease per step (I2), counting the leases a killed run left; after every tick the engine lived through, no batch past the deadline of a running attempt or past its reminder; at the end, once every batch is at rest (on tap, cancelled, Stuck or Conditioning; an Ordered batch has no deadline until it is routed, as in I1), every effect on the code host exactly once and in the ledger, and every effect due recorded and on the code host.
- Runs: `FOEDRUM_RUNS` seeds, 15 in `npm run check`, 200 per pull request in CI and 1,000 in the nightly run, on every leg. A failure names its seed, which `FOEDRUM_SEED` replays, and shows the kills, moves, plays and events. A second test checks that the kills reach every kind of point, an effect found on the code host, a kill soon after a restart and a lost attempt retried, and that a recorded run replays with the same events and kills.

## Consequences
- The M0 exit criterion runs nightly. A kill anywhere in the engine's own code is covered; a kill of a real process tree is not, since the engine and the runner have no process of their own yet. The runner's kill of an orphaned grandchild is an integration test (the Windows case of #92, a todo there until the runner uses a Job Object).
- Not yet covered, and follow-ups: the state branch (a kill between the SQLite commit and the push, and a lost database rebuilt from the branch, which loses the records of effects that were not pushed; finding effects by key covers that too), the real runner killing recorded process trees at restart (#11), and shrinking a failing chaos run.
- Every effect the GitHub layer adds needs a way to be found by its key; one that cannot be found cannot be made safe by the ledger and needs its own decision.

## Alternatives considered
- **Record an intent before applying the effect:** a crash between the intent and the result still leaves the question whether the target has it, so the target must be asked by key anyway; the intent adds an event type and no safety.
- **Apply and record without asking the target:** a kill in between applies the effect twice; the harness catches that mutant in every run of `npm run check`.
- **Release a killed run's leases at start instead of expiring them:** the started attempts would then wait for their deadline and get Stuck, instead of being lost and retried at the next tick.
- **Kill real engine processes:** the most realistic, but there is no engine program yet, and it would be slow and start processes in the chaos layer (ADR 0021).
- **Kill at fixed counts of kill points:** the first version; kills landed early in each run and seldom in the window after an effect reached the code host.
