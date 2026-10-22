# Property tests

**Property tests** on the engine: generated sequences must keep invariants I1–I6.
A seeded generator (`test/helpers/event-sequences.ts`, no dependency) writes event sequences for the fold, and engine scenarios for the invariants: commands chosen from the folded state, supervisor ticks that move a controllable clock, and what the fake brewer runner does in each attempt (hangs, lost attempts, stalls, denial storms).
A scenario runs through `decide`, the guard, the fold, the supervisor and the fake runner on an in-memory store (`test/helpers/simulation.ts`), with one property per invariant in `test/property/`.
Each run starts from a fresh seed; a failure is shrunk to fewer moves and simpler attempts and reported with its seed, moves and events, and setting the environment variable `FOEDRUM_SEED` to that seed replays it.
`FOEDRUM_RUNS` sets how many seeds each property runs: few in `npm run check`, to stay within the per-file budget, 500 on CI's Linux leg per pull request and 1,000 on every leg in the nightly run (ADR 0134).
