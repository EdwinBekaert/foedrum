# Planted-defect sample for /brew-review

Sixteen commits, nine with known defects and seven that check how the red proof classes commits, used to check the review skill and the default lenses after a prompt changes (CLAUDE.md, Tests). The patches are data, not tests: `npm test` never applies them, but `test/unit/planted-demo.test.ts` reads them. Once applied, the sample's own tests pass at its head, so the mutation check compares the review, not a broken fixture. That test keeps one part of this true: it runs the layer guard of `npm run check` on the lines the patches add, so no patch gives a test in a layer `npm test` runs an import of `child_process` or the process runner. A test that starts a process through a module it imports passes that guard and fails only when the sample's tests run (ADR 0038), so check the baseline after changing a patch.

## Apply

Apply the patches on top of the branch whose prompts you are checking (the skill, its agents or the lenses), so the run uses those prompts, not older ones. The patches only add and change files under `src/engine/`, `src/workspace/`, `test/unit/` and `test/integration/` that the sample itself adds, so they apply to any branch that does not have those files yet. In a clean checkout of that branch:

```sh
git switch -c planted/23-review-demo
git am test/fixtures/brew-review/planted-demo/*.patch
```

Then start a new Claude Code session in that checkout (the skill and the `taster` and `brett` agents load from it when the session starts) and run:

```
/brew-review planted/23-review-demo --base <branch> --no-comment
```

`--base <branch>` limits the review to the planted commits and takes the review criteria from your branch. Without it, the review would also cover your branch's own commits, and lenses that are new on your branch would come from the planted branch instead. The summary is written to `.foedrum/tmp/branch-planted-23-review-demo/review/summary.md`.

Afterwards: `git switch <branch>` and `git branch -D planted/23-review-demo`.

If a patch no longer applies because those files now exist, rebase the sample onto a newer branch, export it again with `git format-patch <branch>..planted/23-review-demo`, and update this README.

## Patches

| Patch | Kind | What it is |
|---|---|---|
| `0001` Add failing tests for retry backoff | test + stub | Control: red step done right (`backoffMs` throws `not implemented`) |
| `0002` Compute retry backoff with a cap | implementation | Control: green step |
| `0003` Wait for a bottle to be merged | implementation | **Planted:** `waitForMerge` polls with no deadline; `eventStorePath` builds a path with `homedir() + '/.foedrum/' + …` |
| `0004` Test waiting for a merge | test | **Planted:** tests committed after the code; they pass immediately |
| `0005` Add a failing test for reading the current branch | test + stub | Red step (`not implemented`) in `test/integration/`, where real git is allowed (ADR 0021, ADR 0058); there is no unit test with a fake process runner |
| `0006` Read the current branch with git | implementation | **Planted:** green step for `0005` that runs git directly with `execFileSync`, not through the process runner: no deadline, no tree kill, and no injected runner a unit test could fake |
| `0007` Add failing tests for Brewery names | test + stub | **Planted:** only rejection tests, against a stub that rejects everything (`() => false`); all three pass before any implementation exists |
| `0008` Check Brewery names | implementation | The implementation the rejection tests cannot tell from the stub |
| `0009` Refactor: backoffMs takes its base and cap as one object | refactor | Control: a changed signature, with the tests' call arguments changed and no test name or expected value |
| `0010` Add a failing test for retry delays in whole seconds | test + stub | Control: red step for `backoffSeconds` (`not implemented`), so that `0012` has code to remove |
| `0011` Round retry delays up to whole seconds | implementation | Control: green step |
| `0012` Remove backoffSeconds: nothing calls it | remove | Control: deletes `backoffSeconds` and only its test, with its import |
| `0013` Refactor: name the doubled delay in backoffMs | refactor subject, mixed | **Planted:** the code change is a refactor, but the "never exceeds the cap" test changes its expected value (`10_000` to `5_000`) |
| `0014` Remove the doubled-delay name from backoffMs | remove subject, mixed | **Planted:** folds `backoffMs` back into one expression, keeping the function, and deletes with it the kept "never exceeds the cap" test |
| `0015` Add a failing test for a delay of at least the base | test + stub | Control: red step for "never waits less than the base" (`backoffMs` throws `not implemented` below the first attempt) |
| `0016` Never wait less than the base | implementation, mixed | **Planted:** the code still waits half the base at attempt 0, and the step wraps the red test's assertions in `try { … } catch {}`, so it passes; every line the red step added is still there, so `testsUnchanged` would let it through by the test map ([ADR 0274](../../../../docs/adr/0274-the-red-proof-reads-line-coverage-of-the-change-and-a-test-map-not-test-names.md)) |

## Expected findings

A run should report at least these. Line numbers are in `src/engine/wait-for-merge.ts` after `0003`, unless the row names another file.

| Planted defect | Stage or lens | Expected result |
|---|---|---|
| Tests committed after the code (`0003` → `0004`) | Red proof | **fail**: `0003` has *no red step*; at `0004` both new tests are `ok` (*not red, passing*). The control pair passes: red at `0001` (2 of 2 `not implemented`), green at `0002` |
| | design-conformance | test committed after the implementation; no red step |
| Wait without a deadline (line 13) | correctness | **blocker**, citing CLAUDE.md "Every wait has a deadline" |
| | test-design | gap: no test for a deadline or for `isMerged` failing |
| git run directly (`src/workspace/current-branch.ts` after `0006`, line 5) | design-conformance | **blocker** or **major**, citing the CLAUDE.md rule (Cross-platform) to spawn git through the process runner in `src/platform/processes.ts`, and ADR 0021: the call should go through an injected runner, with a unit test that fakes it with captured `git branch --show-current` output |
| | cross-platform | the same rule: `execFileSync` has no deadline and cannot kill git's tree (ADR 0035) |
| | test-design | may add: the only test is an integration test; no unit test with a fake process runner |
| | Red proof | passes for this pair: red at `0005` (1 of 1 `not implemented`), green at `0006` |
| Rejection tests against a reject-everything stub (`test/unit/brewery-name.test.ts`, `src/workspace/brewery-name.ts` at `0007`) | test-design | **major**: every test passes against `() => false`, so none would fail if `isBreweryName` rejected valid names too; no test accepts a valid name |
| | Red proof | **fail**: at `0007` all 3 new tests are `ok` (*not red, passing*), and the stub returns a value instead of throwing `not implemented`; `0008` has *no red step* |
| | Brett | a mutant that makes `isBreweryName` return `false` for every input (for example `false && /…/.test(name)`) survives; `scripts/mutants.ts --same-answer` writes it (ADR 0278), because every assertion on `isBreweryName` expects `false` |
| A signature Refactor with call-only test edits (`0009`) | Red proof | **refactor**: `test/unit/backoff.test.ts` all `ok` at `0009^` and `0009` (2 of 2), the same leaf names, no expected value changed; the later test of `0010` calls only `backoffSeconds`, which `0009` neither changes nor adds (`0010` adds it), so it shows nothing about `0009`; no red step needed |
| A red/green pair (`0010` → `0011`) | Red proof | passes: red at `0010` (1 of 1 `not implemented`), green at `0011` |
| A Remove of code and only its tests (`0012`) | Red proof | **remove**: all `ok` at `0012^` (3 of 3) and `0012` (2 of 2), the leaf names at `0012` are those at `0012^` less "backoffSeconds > rounds the delay up to whole seconds"; no red step needed |
| An expected value changed in a Refactor (`0013`) | Red proof | **fail**: `0013` is **mixed**, since it changes the expected value of "never exceeds the cap", though its tests are all `ok` at `0013^` and `0013` |
| A kept test deleted in a Remove (`0014`) | Red proof | **fail**: `0014` is **mixed**, since the "never exceeds the cap" test it deletes is one of `backoffMs`'s own tests, and `backoffMs` stays, though its tests are all `ok` at `0014^` (2 of 2) and `0014` (1 of 1) |
| A red test weakened by added lines (`0015` → `0016`, `test/unit/backoff.test.ts`) | test-design | **major**: the `try { … } catch {}` that `0016` adds around the assertions of "never waits less than the base" swallows their failure, so the test passes against the wrong delay (`backoffMs(0, …)` is 50) |
| | Red proof | **fail**: `0016` is **mixed**, since it changes the red test beside the code; the red step passes: red at `0015` (1 of 2 `not implemented`, the other its older test, `ok`) |
| String-built path (line 20) | cross-platform | **blocker**: mixed separators on Windows, citing the CLAUDE.md paths rule |
| | security | unvalidated Brewery name allows `../` traversal out of `~/.foedrum` |
| | design-conformance | the same paths rule; the store location also contradicts the Brewery layout in the architecture document and ADR 0011 |
| Weak tests | Brett | mutants that survive despite 100% coverage, for example a dropped `await` on the sleep, a sleep of 0, swallowed `isMerged` errors, or a dropped `homedir()` |
| | Coverage delta | 100% for both new files: coverage alone does not catch the defects |

Findings that were not planted but are correct, and may appear: `backoffMs` accepts NaN, and before `0016` 0 and negative numbers; after `0014` no test reaches the cap, so a dropped `Math.min` passes; the backoff tests use one cap, so a hard-coded cap (`Math.min(10_000, …)`) passes; the `eventStorePath` test only matches `/my-brewery/`; "the bottle's pull request" goes against the glossary (a bottle *is* a pull request); the branch mixes unrelated changes; `isBreweryName` accepts Windows reserved names (`con`, `nul`, `aux`, `com1`); `currentBranch` returns an empty string on a detached HEAD and runs git without a timeout; the merge wait is an in-memory loop rather than Conditioning recorded as events (ADR 0013; ADR 0025's `batch.waiting` with a reminder); the integration test runs `git init` without a timeout; the event store under `~/.foedrum/<brewery>/` is a new location that contradicts ADR 0011; `eventStorePath`'s comment says "the Cellar" (the autonomous driver in the glossary) for what keeps the event store.

Correctness reviews the code, not its tests ([ADR 0022](../../../../docs/adr/0022-five-default-lenses.md)): a correctness finding about the tests (a missing test, a test that cannot fail) means the lenses overlap again.

A run that misses a **planted** defect means a prompt change made the review weaker. Compare the run with this table in the pull request that changes the prompt.
