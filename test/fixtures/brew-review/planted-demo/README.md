# Planted-defect sample for /brew-review

Eight commits with known defects, used to check the review skill and the default lenses after a prompt changes (CLAUDE.md, Tests). The patches are data, not tests: `npm test` never applies them, but `test/unit/planted-demo.test.ts` reads them. Once applied, the sample's own tests pass at its head, so the mutation check compares the review, not a broken fixture. That test keeps one part of this true: it runs the layer guard of `npm run check` on the lines the patches add, so no patch gives a test in a layer `npm test` runs an import of `child_process` or the process runner. A test that starts a process through a module it imports passes that guard and fails only when the sample's tests run (ADR 0038), so check the baseline after changing a patch.

## Apply

Apply the patches on top of the branch whose prompts you are checking (the skill, its agents or the lenses), so the run uses those prompts, not older ones. The patches only add files under `src/engine/`, `src/workspace/`, `test/unit/` and `test/integration/`, so they apply to any branch that does not have those files yet. In a clean checkout of that branch:

```sh
git switch -c planted/23-review-demo
git am test/fixtures/brew-review/planted-demo/*.patch
```

Then start a new Claude Code session in that checkout (the skill and the `taster` and `brett` agents load from it when the session starts) and run:

```
/brew-review planted/23-review-demo --base <branch> --no-comment
```

`--base <branch>` limits the review to the eight planted commits and takes the review criteria from your branch. Without it, the review would also cover your branch's own commits, and lenses that are new on your branch would come from the planted branch instead. The summary is written to `.foedrum/tmp/branch-planted-23-review-demo/review/summary.md`.

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
| | Brett | a mutant that makes `isBreweryName` return `false` for every input (for example `false && /…/.test(name)`) survives; the reviewer prompt asks for it, because every assertion on `isBreweryName` expects `false` |
| String-built path (line 20) | cross-platform | **blocker**: mixed separators on Windows, citing the CLAUDE.md paths rule |
| | security | unvalidated Brewery name allows `../` traversal out of `~/.foedrum` |
| | design-conformance | the same paths rule; the store location also contradicts the Brewery layout in the architecture document and ADR 0011 |
| Weak tests | Brett | mutants that survive despite 100% coverage, for example a dropped `await` on the sleep, a sleep of 0, swallowed `isMerged` errors, or a dropped `homedir()` |
| | Coverage delta | 100% for both new files: coverage alone does not catch the defects |

Findings that were not planted but are correct, and may appear: `backoffMs` accepts 0, negative numbers or NaN; the `eventStorePath` test only matches `/my-brewery/`; "the bottle's pull request" goes against the glossary (a bottle *is* a pull request); the branch mixes unrelated changes; `isBreweryName` accepts Windows reserved names (`con`, `nul`, `aux`, `com1`); `currentBranch` returns an empty string on a detached HEAD and runs git without a timeout; the merge wait is an in-memory loop rather than Conditioning recorded as events (ADR 0013; ADR 0025's `batch.waiting` with a reminder); the integration test runs `git init` without a timeout; the event store under `~/.foedrum/<brewery>/` is a new location that contradicts ADR 0011; `eventStorePath`'s comment says "the Cellar" (the autonomous driver in the glossary) for what keeps the event store.

Correctness reviews the code, not its tests ([ADR 0022](../../../../docs/adr/0022-five-default-lenses.md)): a correctness finding about the tests (a missing test, a test that cannot fail) means the lenses overlap again.

A run that misses a **planted** defect means a prompt change made the review weaker. Compare the run with this table in the pull request that changes the prompt.
