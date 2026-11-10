# 0367. The demo's second order holds what `foedrum brew`'s integration test held

Date: 2026-11-10 · Status: Accepted · Amends [0185](0185-npm-run-demo-tastes-through-a-parallel-group-of-three-lenses.md) (where `foedrum brew`'s run of the demo's Brewery is tested)

## Context
`test/integration/brew.test.ts` runs `runBrew` on the demo's scratch Brewery, with real git, the `nip-parallel` recipe and `DEMO_SCRIPT`, from an order with no batch to its pull request ([ADR 0185](0185-npm-run-demo-tastes-through-a-parallel-group-of-three-lenses.md)).
`npm run demo` brews its second order the same way: `foedrum brew` through `runBrew`, on the same Brewery, recipe and script (ADR 0139, ADR 0185).
`test/integration/demo.test.ts` runs the demo on every CI leg (Linux, Windows and macOS) and asserts that it exits 0, and the demo exits 1 when `problemsOf` finds a problem in its run.
The demo test already asserts the brew test's lines: the order, the route to `nip-parallel`, and on tap with its pull request.
`problemsOf` already checks that the code host has two pull requests.
The one thing only the brew test checked is the tip of the bottle branch: the Cellarman's third fix, after the blocking lens's finding ([ADR 0193](0193-npm-run-demo-shows-a-tasting-loop.md)).
The audit of the integration suite (#869) found the file duplicates the demo's second order except for that tip (#898).

## Decision
- **`problemsOf` checks the tip of the second order's bottle branch**: the demo reads the subject of its tip from the target's bare remote, and a tip other than the Cellarman's third fix (`FIX_MESSAGE` in `scripts/demo/core.ts`) is a problem of the run.
- **`test/integration/brew.test.ts` goes**: the demo's second order, run by `test/integration/demo.test.ts` on every CI leg, holds each case it held.

## Consequences
- `foedrum brew`'s run of the demo's Brewery is tested once per CI leg, in the demo, not twice.
- A change that makes `foedrum brew` push another tip, or none, fails the demo test with `problemsOf`'s line.
- `foedrum brew`'s own logic stays in `test/unit/brew.test.ts`, on fakes.

## Alternatives considered
- **Keep `brew.test.ts`.** A second full recipe run on real git per leg, for one assertion the demo can make.
- **Check the tip in `test/integration/nip.test.ts`.** It checks its bottle branch's log already, but it brews Nip through `foedrum serve`, not `foedrum brew`.
