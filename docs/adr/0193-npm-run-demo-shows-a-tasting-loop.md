# 0193. `npm run demo` shows a tasting loop

Date: 2026-10-25 · Status: Accepted · Amends [0185](0185-npm-run-demo-tastes-through-a-parallel-group-of-three-lenses.md) (the demo's recipe)

## Context
`npm run demo` brews with the demo Brewery's own recipe, `nip-parallel`: three lens steps in a parallel group, all advisory (ADR 0185). No default recipe and nothing in the demo uses a blocking lens step, so nobody can watch a tasting loop: a round that asks for changes, goes back, gets a fix, and passes (#261). ADR 0190, 0191 and 0192 give that loop its rules.

## Decision
- **One lens step of the demo's recipe blocks:** `"blocking": true`, `onBlocked` with `findings` back to `implement`, `maxRounds: 1`. The other lens steps stay advisory.
- **The demo's scripted brewers play the loop:** round 1's Taster asks for changes with one finding; the Cellarman fixes it and records it `fixed` (ADR 0191); round 2's Taster gets the change since round 1 (ADR 0190) and the disposed finding, and approves.
- **The walk-through says where the second round shows:** the status comment's path line, round 2's inputs, the finding marked fixed. The demo stays offline and scripted (ADR 0097).
- **Nip in `defaults/` is unchanged.** Whether a default recipe should block on a lens is its own decision.

## Consequences
- Anyone who runs the demo sees a blocking review go back once and pass, which no default recipe shows yet.
- The demo runs a few more scripted attempts; its integration test's hang guard counts them by recipe (ADR 0185).

## Alternatives considered
- **Make Nip's correctness lens block:** left out. It would cost every Nip batch rounds of real brewer runs; a decision of its own, not a demo's.
