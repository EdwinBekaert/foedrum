# Planted-defect sample for /brew-review

Four commits with known defects, used to check the review skill and the default lenses after a prompt changes (CLAUDE.md, Tests). The patches are data, not tests: nothing here runs in `npm test`.

## Apply

The patches apply to base commit `65b46ecb2591bf321061e0a3ccf8fc99c0df4db5` ("Add review skill and default tasting lenses"). Apply them in a scratch worktree under `.foedrum/tmp/`, never in your own checkout:

```sh
git worktree add --detach .foedrum/tmp/planted-demo 65b46ecb2591bf321061e0a3ccf8fc99c0df4db5
git -C .foedrum/tmp/planted-demo switch -c planted/23-review-demo
git -C .foedrum/tmp/planted-demo am "$PWD"/test/fixtures/brew-review/planted-demo/*.patch
```

Then run `/brew-review planted/23-review-demo --no-comment` from that worktree. `npm test` is green there (9 of 9 pass), and both new files have 100% line coverage. Afterwards, remove the worktree (`git worktree remove --force .foedrum/tmp/planted-demo`, then `git worktree prune`) and delete the local branch.

## Patches

| Patch | Kind | What it is |
|---|---|---|
| `0001` Add failing tests for retry backoff | test + stub | Control: red step done right (`backoffMs` throws `not implemented`) |
| `0002` Compute retry backoff with a cap | implementation | Control: green step |
| `0003` Wait for a bottle to be merged | implementation | **Planted:** `waitForMerge` polls with no deadline; `eventStorePath` builds a path with `homedir() + '/.foedrum/' + …` |
| `0004` Test waiting for a merge | test | **Planted:** tests committed after the code; they pass immediately |

## Expected findings

A run should report at least these. Line numbers are in `src/engine/wait-for-merge.ts` after `0003`.

| Planted defect | Stage or lens | Expected result |
|---|---|---|
| Tests committed after the code (`0003` → `0004`) | Red proof | **fail**: `0003` has *no red step*; at `0004` both new tests are `ok` (*not red, passing*). The control pair passes: red at `0001` (2 of 2 `not implemented`), green at `0002` |
| | design-conformance | test committed after the implementation; no red step |
| Wait without a deadline (line 13) | correctness | **blocker**, citing CLAUDE.md "Every wait has a deadline"; also a gap: no deadline or error-path tests |
| String-built path (line 20) | cross-platform | **blocker**: mixed separators on Windows, citing the CLAUDE.md paths rule |
| | security | unvalidated Brewery name allows `../` traversal out of `~/.foedrum` |
| | design-conformance | the same paths rule; the store location also contradicts the Brewery layout in the architecture document and ADR 0011 |
| Weak tests | Brett | mutants that survive despite 100% coverage, for example a dropped `await` on the sleep, a sleep of 0, swallowed `isMerged` errors, or a dropped `homedir()` |
| | Coverage delta | 100% for both new files: coverage alone does not catch the defects |

Findings that were not planted but are correct, and may appear: `backoffMs` accepts 0, negative numbers or NaN; the `eventStorePath` test only matches `/my-brewery/`; "the bottle's pull request" goes against the glossary (a bottle *is* a pull request); the branch mixes unrelated changes.

A run that misses a **planted** defect means a prompt change made the review weaker. Compare the run with this table in the pull request that changes the prompt.
