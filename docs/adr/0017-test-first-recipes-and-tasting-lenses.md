# 0017. Test-first recipes and tasting lenses

Date: 2026-10-13 · Status: Accepted

## Context
When one agent writes both the tests and the code, it tends to write tests that fit the code it already has in mind. The tests pass, but they prove little. Telling the agent to work "test-first" does not change this: whether it did is not observable, and the engine must not depend on a model choosing to follow advice. Likewise, a single broad review ("review this diff") finds less than several focused reviews, and passing tests say nothing about whether the tests would notice a bug.

The same applies to developing Foedrum itself.

## Decision

### Test-first is a recipe structure, not an instruction
- Recipes declare **`testFirst`** (default `true` for recipes that write code). The router may switch it off for an order whose change cannot be expressed as a failing test (documentation-only, pure refactoring) and records why in the status comment.
- A new default brewer, the **Gauger**, writes failing tests only, from the order and the plan, and commits them. Source files are denied to it.
- In bug-fix recipes the **Microbiologist**'s reproducing test is the failing test; no Gauger step is needed.
- A gravity reading with **`"expect": "fail"`** and **`"of": "<step id>"`** is the **red proof**. It passes only when the tests committed by that step fail on assertions, and no compile, import or collection error occurred.
- Red proof needs a **structured test report**, not an exit code. Each repository declares how its tests report (`testReport`: TAP or JUnit XML, and where to find it). A recipe that needs red proof on a repository without a test report stops at the start of the batch as Stuck (`environment`), with the fix named.
- **Cellarman** makes the failing tests pass. The **`testsUnchanged`** guard rejects an attempt that changes or removes the test declarations or assertions committed by the red step. Helpers, fixtures, imports and new tests may change.
- When Cellarman believes a test is wrong, it reports `blocked` + `findings`. The step's **`onBlocked`** routing sends the findings back to the Gauger as an in-doc (one round by default); after that, the batch becomes Stuck for a human.

### Tasting is done through lenses
- A recipe step gives the **Taster** a **`lens`** parameter. Default lenses (`defaults/lenses/*.md`): correctness, security, cross-platform, design conformance. A Brewery can add or override lenses.
- Lenses run in a **`parallel`** group. Each child is its own attempt, with its own lease and deadline, and never writes the task tree. The group has an `id`; its **verdict** is `approve` only when every child approves.
- House yeast gains an optional **lens** scope dimension, so a rule can target one lens (amends [ADR 0015](0015-house-yeast.md)).

### Brett: an advisory mutation check
- A new default brewer, **Brett** (after *Brettanomyces*, the wild yeast that spoils a batch), proposes a small number of **mutants**: plausible bugs in the changed code, each as a patch.
- The **engine**, not the model, decides which mutants count: it applies each patch in a disposable `scratch` tree and runs the gravity reading. A mutant is a **confirmed survivor** only when the tests still pass. Nothing Brett changes is committed.
- Confirmed survivors are listed in the pull request and handed to the Cooper with the lens findings whenever it runs. By default they are **advisory**: they do not affect the group verdict, so equivalent mutants and new mutants each round cannot leave a batch Stuck. A recipe can make Brett a gate (`"gate": true`).

### Foedrum is developed the same way
Contributions follow red → green → refactor, with a test commit before the implementation commit. A review skill for Foedrum's own pull requests runs red proof, simplification, the lens reviews, a mutation check and a coverage delta, and it reads the same lens files Foedrum ships.

Skills stay available to brewers (`skills` field), for example for a target repository's own conventions, but no default workflow depends on a skill being followed.

## Consequences
- "The tests came first" becomes a verifiable fact recorded in the batch, not a claim in a prompt. Mutation results are evidence about test strength, re-checked by the engine, but advisory by default because model-proposed mutants can be equivalent to the original.
- Repositories need a machine-readable test report for red proof; most test runners can produce TAP or JUnit XML.
- More steps per batch: one extra brewer (Gauger) for every writing recipe, and parallel lens sessions plus Brett for reviews. The model per step stays tunable through `models.jsonc` and blind tasting.
- The lens prompts are exercised on Foedrum's own pull requests before they ship as defaults.

## Alternatives considered
- **A test-first instruction or skill for Cellarman:** cheapest, but unverifiable, and the model decides whether to comply.
- **Red proof from the exit code:** no configuration, but cannot tell a failing assertion from a compile error, or which tests failed.
- **A file-level guard on test files:** simple, but blocks legitimate changes to helpers, fixtures and imports.
- **One broad Taster:** fewer sessions, but less depth per concern and one long context instead of several short ones.
- **Brett as a hard gate:** stricter, but nondeterministic mutants would strand batches.
- **A mutation testing library:** deterministic, but a large, language-specific dependency per target repository; a brewer works in any language and needs no package.
- **Coverage thresholds only:** cheap and kept as a gravity reading where a repository has them, but coverage shows code ran, not that a test would fail on a bug.
