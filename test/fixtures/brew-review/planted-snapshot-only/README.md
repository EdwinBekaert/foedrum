# Planted-defect sample: a snapshot-only test whose name promises lines

A change and the base it is made on, used to check `defaults/lenses/diff/test-design.md` after a prompt changes (CLAUDE.md, Tests), with [planted-drifted-fake](../planted-drifted-fake/README.md) and [planted-empty-passes](../planted-empty-passes/README.md) (#1099).
It is built from `test/unit/cli.test.ts`, whose doctor test "reports permissions only on native Windows, recommends WSL2" checks only a snapshot of the whole report.
The files are data: no test applies them.
#1096 moves this sample, with the other lens samples, into the tasting room.

- `0001`: the base, a tiny repository: `src/doctor.mjs` reports each tool's version, and its test checks the whole text.
- `0002`: the change: on native Windows the report adds a permissions line and recommends WSL2, with a test named for those lines that checks only `t.assert.snapshot`, and its snapshot file.

Both commits' tests pass.

## Apply

As for [planted-acceptance](../planted-acceptance/README.md#apply), with this folder's patches; the bundle needs no `order.md`.

## Expected findings

| Defect | Expected result |
|---|---|
| `test/doctor.test.mjs:12` checks only a snapshot, where its name promises the permissions and WSL2 lines | **found**: a finding on that line, introduced: a snapshot update without those lines passes; asks for an assertion on each line the name promises |

Findings that may appear and are not wrong: no test for a platform other than `linux` and `win32`; the snapshot was written from the code it tests.

A run that misses the snapshot-only test means a prompt change made the lens weaker. Compare the run with this table in the pull request that changes the prompt.
