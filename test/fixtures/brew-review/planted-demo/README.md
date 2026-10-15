# Planted-defect sample for /brew-review

Eight commits with known defects, used to check the review skill and the default lenses after a prompt changes (CLAUDE.md, Tests). The patches are data, not tests: nothing here runs in `npm test`.

## Apply

Apply the patches on top of the branch whose prompts you are checking (the skill, its agents or the lenses), so the run uses those prompts, not older ones. The patches only add files under `src/engine/`, `src/workspace/` and `test/unit/`, so they apply to any branch that does not have those files yet. In a clean checkout of that branch:

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
| `0005` Add a failing test for reading the current branch | test + stub | **Planted:** the unit test runs `git init` on a real directory (ADR 0021); otherwise a correct red step (`not implemented`) |
| `0006` Read the current branch with git | implementation | Green step for `0005`; spawns git directly instead of through an injected process runner |
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
| Unit test runs git (`test/unit/current-branch.test.ts`, line 12) | test-design | **blocker** or **major**, citing ADR 0021 / CLAUDE.md "Unit tests never start a process"; the branch name should come from a fake process runner with captured `git branch --show-current` output |
| | design-conformance | may also cite ADR 0021 for `0006` spawning git without an injected runner |
| | Red proof | passes for this pair: red at `0005` (1 of 1 `not implemented`), green at `0006` |
| Rejection tests against a reject-everything stub (`test/unit/brewery-name.test.ts`, `src/workspace/brewery-name.ts` at `0007`) | test-design | **major**: every test passes against `() => false`, so none would fail if `isBreweryName` rejected valid names too; no test accepts a valid name |
| | Red proof | **fail**: at `0007` all 3 new tests are `ok` (*not red, passing*), and the stub returns a value instead of throwing `not implemented`; `0008` has *no red step* |
| | Brett | a mutant that makes `isBreweryName` return `false` (or inverts the test) survives |
| String-built path (line 20) | cross-platform | **blocker**: mixed separators on Windows, citing the CLAUDE.md paths rule |
| | security | unvalidated Brewery name allows `../` traversal out of `~/.foedrum` |
| | design-conformance | the same paths rule; the store location also contradicts the Brewery layout in the architecture document and ADR 0011 |
| Weak tests | Brett | mutants that survive despite 100% coverage, for example a dropped `await` on the sleep, a sleep of 0, swallowed `isMerged` errors, or a dropped `homedir()` |
| | Coverage delta | 100% for both new files: coverage alone does not catch the defects |

Findings that were not planted but are correct, and may appear: `backoffMs` accepts 0, negative numbers or NaN; the `eventStorePath` test only matches `/my-brewery/`; "the bottle's pull request" goes against the glossary (a bottle *is* a pull request); the branch mixes unrelated changes.

Correctness reviews the code, not its tests ([ADR 0022](../../../../docs/adr/0022-five-default-lenses.md)): a correctness finding about the tests (a missing test, a test that cannot fail) means the lenses overlap again.

A run that misses a **planted** defect means a prompt change made the review weaker. Compare the run with this table in the pull request that changes the prompt.
