# 0017. Test-first recipes and tasting lenses

Date: 2026-10-13 · Status: Accepted

## Context
When one agent writes both the tests and the code, it tends to write tests that fit the code it already has in mind. The tests pass, but they prove little. Telling the agent to work "test-first" does not change this: whether it did is not observable, and the engine must not depend on a model choosing to follow advice. Likewise, a single broad review ("review this diff") finds less than several focused reviews, and passing tests say nothing about whether the tests would notice a bug.

The same applies to developing Foedrum itself.

## Decision
**Test-first is a recipe structure, not an instruction.**
- A new default brewer, the **Gauger**, writes failing tests only, from the order and the plan, and commits them. Source files are denied to it.
- Gravity readings accept `"expect": "fail"`: the **red proof**. It passes only when the run fails *in the tests added or changed by the previous step*. Compile, import or collection errors do not count as red.
- **Cellarman** makes the Gauger's tests pass. The **`testsUnchanged`** guard rejects an attempt that modifies files committed by the red step. A test the Cellarman believes is wrong goes back through the out doc (`blocked` + `findings`).
- Writing recipes are test-first by default; a step can opt out with `"testFirst": false` (for example, documentation-only orders).

**Tasting is done through lenses.**
- The **Taster** takes a `lens` input. Default lenses (`defaults/lenses/*.md`): correctness, security, cross-platform, design conformance. A Brewery can add or override lenses.
- Lenses run as parallel, read-only steps. Each lens is a fresh session with only the diff, its in-docs and house yeast scoped to the lens.
- A new default brewer, **Brett** (after *Brettanomyces*, the wild yeast that spoils a batch), runs a **mutation check**. In a disposable `scratch` tree it introduces plausible bugs into the changed code, runs the gravity reading per mutant and reports surviving mutants as findings. Nothing Brett changes is committed.
- Findings from every lens and from Brett feed the existing review/fix loop.

**Foedrum is developed the same way.** Contributions follow red → green → refactor with a test commit before the implementation commit. A review skill for Foedrum's own pull requests runs red proof, simplification, the lens reviews, a mutation check and a coverage delta, and it reads the same lens files Foedrum ships.

Skills stay available to brewers (`skills` field), for example a target repository's own conventions, but no default workflow depends on a skill being followed.

## Consequences
- "The tests came first" and "the tests catch bugs" become verifiable facts recorded in the batch, not claims in a prompt.
- More steps per batch: one extra brewer (Gauger) for every writing recipe, and parallel lens sessions plus Brett for reviews. The model per step stays tunable through `models.jsonc` and blind tasting.
- The lens prompts are exercised on Foedrum's own pull requests before they ship as defaults.

## Alternatives considered
- **A test-first instruction or skill for Cellarman:** cheapest, but unverifiable, and the model decides whether to comply.
- **One broad Taster:** fewer sessions, but less depth per concern and one long context instead of several short ones.
- **A mutation testing library:** deterministic, but a large dependency that is language-specific per target repository; a brewer works in any language and needs no package.
- **Coverage thresholds only:** cheap and kept as a gravity reading where a repository has them, but coverage shows code ran, not that a test would fail on a bug.
