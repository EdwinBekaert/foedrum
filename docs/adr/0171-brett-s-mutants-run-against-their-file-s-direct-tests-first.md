# 0171. Brett's mutants run against their file's direct tests first, and the wide list only when they survive

Date: 2026-10-24 · Status: Accepted · Amends [0054](0054-test-runs-below-normal-priority-and-review-runs-scoped-to-the-question.md) (the mutation check's one list of tests becomes two rounds)

## Context
Stage 4 of /brew-review runs a baseline and then each of Brett's valid mutants, one after the other, over one list of test files: every file in `test/unit/`, `test/property/` and `test/chaos/` that imports a mutated file directly or through one module in between (`scripts/mutant-tests.ts`, ADR 0054).
For a file that much of the code imports, that list is most of the suite.

On #443 (one source file, `src/schemas/primitives.ts`) it was 57 of the 195 test files, so the baseline and five mutants ran 57 files six times: about 10 minutes, with four other sessions on the same laptop.
The pull request's own tests were three of those files, and each of the five mutants was killed by a test that imports `primitives.ts` directly.
The files one module away matter only for a mutant the direct tests miss.

## Decision
- **`scripts/mutant-tests.ts` gives two lists.** With `--direct` it prints the test files that import one of the given files directly; without it, as before, the wide list: those and the ones that import a given file through one module in between. `scripts/mutant-tests/core.ts` decides both (`testRounds`).
- **Round 1 runs the direct list.** A baseline of the direct importers of every valid mutant's file, then each mutant against the same files. A test the mutant makes fail kills it (ADR 0040), in round 1.
- **Round 2 runs the wide list, only for a round-1 survivor.** Its baseline over the wide list runs once, the first time a mutant needs it, and each round-1 survivor then runs against the wide list. A test it makes fail kills it, in round 2; otherwise it survives. A survivor is still a mutant that no test of the wide list kills, as under ADR 0054.
- **An empty list skips its round.** With no direct importer, every mutant goes to round 2. With no file in the wide list either, there is one round over the three layers, as before.
- **Each verdict compares a run with the baseline of the same files**, so a test missing from a mutant's run is missing because its file failed, never because it was left out (ADR 0040, ADR 0054).
- **The summary names, per mutant, the round that killed it, and the stage's time.**

## Consequences
- A mutant the direct tests kill runs only those, and the baseline does too: on #443, 3 files instead of 57 per run (see Verification).
- A mutant that survives round 1 costs one more run than before, over the direct list, and the first one also costs the direct baseline. When every mutant survives, the stage takes longer than under ADR 0054 by those runs; the direct list is a few files, so that is the smaller cost.
- A mutant killed in round 1 is named with the first failing test of its direct importers, and its count of killing tests is smaller than a wide run would give. Neither changes the verdict.
- A review run with criteria from a base before this record has a `mutant-tests.ts` without `--direct`; stage 4 then runs one round over the wide list, as before.

## Alternatives considered
- **A direct list per mutated file, each with its own baseline:** fewer files per mutant when a review mutates several files, but one baseline per file; most reviews mutate one or two files, and the union is still the direct importers.
- **Run each mutant's wide list in parallel with others:** the same work at once, against ADR 0054's one run at a time, which keeps the terminal and other sessions responsive.
- **Stop a run at its first failing test:** the run still starts every file it was given, and the verdict needs the outcomes of the tests that did run.
