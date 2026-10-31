# 0282. A stale test map sends back the change that made it, and the Maltster surveys a new one

Date: 2026-10-31 · Status: Accepted · Amends [0274](0274-the-red-proof-reads-line-coverage-of-the-change-and-a-test-map-not-test-names.md) (where and when freshness is read, what a stale map does to a step, and the step that proposes a map), [0018](0018-house-yeast-layers.md) (a stale map the Brewery keeps is named, never updated by the batch) and [0069](0069-check-steps-run-the-repositorys-commands-in-an-attempt-of-their-own.md) (a check step that runs the tests fails before its checks when its batch left the test map stale)

## Context
[ADR 0274](0274-the-red-proof-reads-line-coverage-of-the-change-and-a-test-map-not-test-names.md) decides that a test map goes stale by change, never by age: when the files its `derivedFrom.globs` match at a step's tip differ from the `derivedFrom.paths` it records, or when a run reports a test or writes a report outside it.
It decides that the brewer whose change made the map stale updates it in that change, and that a batch's first step proposes a map when the base has none or a stale one.
It leaves to the build which step reads freshness, what a stale map does to it, which brewer proposes a map, and how.

#706 ([#715](https://github.com/EdwinBekaert/foedrum/pull/715)) built the map as data, and the Brewery fallback of [ADR 0018](0018-house-yeast-layers.md): with `"testMap": "brewery"`, the map is the Brewery's file, the same at every commit.
A batch's brewer cannot write the Brewery, so under the fallback "the brewer updates the map in its change" cannot hold.

Three facts of the engine shaped the choices below.
- A check step's retryable failure means "read nothing" ([`CHECK_RETRIES`](../../src/engine/recipe-files.ts)): the same step runs again on the same tree, and would read the same staleness until its attempts ran out. What sends a check step's failure to a brewer is its `onFail` route, which a failure that is not retryable takes at once.
- A map that is stale on the base would make every step of every batch stale, since no batch changed it. Until the survey below lands, no step could proceed in such a repository.
- The test reports carry no test locations yet: [#709](https://github.com/EdwinBekaert/foedrum/issues/709) adds them to the TAP and JUnit readers.

## Decision

### Freshness by manifests, before the run
- **Which steps read it**: a check step that runs the tests (a red proof, or a step whose checks include `test`), in a repository that has a test map at the step's tip. A step without a test check never reads the map.
- **How**: before the repository's setup and the first check, `git ls-files -z` in the attempt's worktree, with every glob after `--` and given git's `glob` magic (`:(glob)<glob>`), so `**` crosses folders, `*` stays within one, no glob is read as an option, and a glob that starts with `:` is a path. The files listed are compared as sets with `derivedFrom.paths`: a file listed and not recorded is `added`, one recorded and not listed is `removed`.
- **A map in the repository that the batch made stale fails the step** back along its `onFail` route, not retryably, so the brewer the route names (the one whose change it checks) updates the map in its change. The batch made the map stale when the map is stale at the tip and the batch's change, from where it starts (the base it merged, else its start, [ADR 0164](0164-a-batch-merges-its-base-before-its-last-check.md)) to the tip, touched the map or a path its globs match: `git diff --name-only -z --no-renames` in the clone, with the same pathspecs. The brewer then refreshes the whole map, base-stale paths included.
  The reason names up to 10 paths, each with `(added)` or `(removed)`, and counts the rest:

  > the test map of acme/api is stale: its derivedFrom.globs match svc/test/Billing.Tests/Billing.Tests.csproj (added), old/Old.csproj (removed); update .foedrum/test-map.jsonc in this change (ADR 0274, ADR 0282)
- **A map stale on the base, which the batch did not touch, never fails a step.** It is recorded on the step's `step.finished` and named in the status comment, and the survey below refreshes it.
- A git read that fails, in the worktree or the clone, blocks the step on its environment, naming git's last line.

### Freshness by runs, after a passing run
- **Only a run whose test check exited 0 is read**, as only such a run judges a module unreached ([ADR 0280](0280-a-new-module-is-judged-unreached-only-on-a-passing-test-run.md)): a failing run may stop before a module it reaches.
- After the unreached rule of ADR 0274, the map is stale by the run when a module the base's map lists has no report at its `testReport` path, or when the test report `foedrum.jsonc` names was written under no module's `testReport` or `coverage` path. A module only the batch adds was looked for by the unreached rule already.
- **A map stale by a run never fails a step**: a run can disagree for reasons the brewer does not control, such as a runner that writes its report elsewhere on one platform. It is recorded and named, as a base-stale map is.
- A reported test whose location lies outside every module and area of the effective map makes the map stale too. It needs the locations #709 adds, and whichever of #709 and #718 lands second adds it.

### Recorded on the step, named in the status comment
- `step.finished` gains `staleMap`: where the map is kept (`repo` or `brewery`), the first 10 stale paths, each with why (`(added)`, `(removed)`, `(a report outside the map)`, `(no report of module "<name>")`), and how many more.
- The status comment names the latest one, from the batch's latest finished attempt that recorded a stale map or ran the tests, as one line after the sensitive-path lines: `The test map is stale: …`, or `The Brewery's test map is stale: …`. A later run of the tests that found the map fresh takes the line off.

### The Brewery fallback: named, never a failure
- With `"testMap": "brewery"`, freshness by manifests and by runs is read as for a map in the repository, but a stale map never fails a step and the batch's change is not read: the batch goes on with the Brewery's map, and the status comment says `The Brewery's test map is stale: <paths>`.
- A person refreshes the Brewery's file. The line stays on every batch of the repository until the file changes and serve reads it again.

### The Maltster's `survey` step proposes a map
This part is built by [#708](https://github.com/EdwinBekaert/foedrum/issues/708), decided with the maintainer on 2026-10-31.
- **The Maltster**, a new default brewer in `defaults/brewers/`, proposes the map in a `survey` step of its own, at the head of the test-first recipes.
  Not the Gauger: the red proof would then read a map that the same brewer had just written. Not a rules-based command: that would need rules per language in Foedrum ([ADR 0023](0023-language-independent-recipes.md)).
- **It runs only when the effective map is missing or stale by manifests**, a condition the engine evaluates before the step, never the brewer. Otherwise the step is skipped.
- **Its guards allow it to write `.foedrum/test-map.jsonc` only.** It reads the repository's manifests, and records in `derivedFrom` the globs it used and the paths `manifestFreshness` lists for them, so the map it writes is fresh by construction.
- **The engine checks its map against one run** of the confirmed `test` line before the Gauger starts: the run's reports must be where the map says (the unreached rule and freshness by runs above). When no map the Maltster proposes agrees with a run, the batch is Stuck (`environment`), naming what disagreed.
- **The pull request carries the proposed map** through the sensitive-path line the map already gets ([ADR 0201](0201-a-repository-names-its-sensitive-paths-and-a-batch-that-touches-one-says-so.md)), with a line that says why the map changed (new, or stale, with the stale paths).
- **Under the Brewery fallback the survey does not run**: it cannot write the Brewery. The stale line above stands.
- **Until #708 lands**, a repository with no test map keeps today's name reading in the red proof and `testsUnchanged`, as #709 and #711 build them.
- #708 calls freshness as one function: `manifestFreshness(git)(worktree, map, signal)` in `src/checks/test-map.ts`, which gives `{ kind: 'fresh' }`, `{ kind: 'stale', added, removed }` or `{ kind: 'unread', reason }`.

## Consequences
- A brewer that adds or removes a manifest without updating a map in the repository sees its change sent back by the next check step that runs the tests, with the paths to record.
- Every check step that runs the tests in a repository with a map costs one `git ls-files` in the worktree, and, when the map is stale, one `git diff` in the clone.
- A map stale on the base no longer stops anything; it is named until the survey refreshes it or a person does.
- A batch that touched a manifest refreshes the whole map, base-stale paths included: a smaller rule ("only the paths the batch made stale") would leave the map stale in the same change.
- A stale Brewery-kept map is visible on every batch of its repository, and only a person can clear it.
- The status comment gains one line, in the same place as the map's sensitive-path lines.

## Alternatives considered
- **Fail a check step retryably, as #718 first said.** A check step's retry reads the same tree and the same staleness three times before its `onFail` route; the failure that is not retryable takes that route at once.
- **Read freshness at a brewer step's tip, in the brewer runners, retryably**, as a plan's `touches` are checked ([ADR 0233](0233-a-plan-is-an-out-doc-whose-paths-the-engine-checks-shown-as-one-comment-per-order.md)). The brewer that made the map stale would retry at once, but the check sits on two runners (headless and interactive) and every brewer step, including the read-only Tasters, for about 200 more lines. A check step that runs the tests follows every step that changes code in a test-first recipe.
- **Fail every step whose tip is stale.** Until the survey lands, a map stale on the base would stop every batch of its repository.
- **Compare the tip's stale paths with the base's**, instead of asking whether the batch touched the map or a manifest. The same reads, but a batch that touched a manifest could leave the base's stale paths in the map it ships.
- **Record a stale Brewery-kept map at the push**, as `unmeasured` is. Freshness by runs is read in the check runner anyway, so one field on `step.finished` serves both, and a later fresh run clears it.
- **Make a stale Brewery-kept map Stuck.** The batch can do nothing about it; a person refreshes the Brewery's file whenever they choose.
