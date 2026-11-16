# Planted-defect sample: a test that passes on an empty result

A change and the base it is made on, used to check `defaults/lenses/diff/test-design.md` after a prompt changes (CLAUDE.md, Tests), with [planted-drifted-fake](../planted-drifted-fake/README.md) and [planted-snapshot-only](../planted-snapshot-only/README.md) (#1099).
It is built from `test/unit/status-failing.test.ts`, whose test of a summary that reads like a secret asserts only that the token is not there.
The files are data: no test applies them.

- `0001`: the base, a tiny repository: `src/status.mjs` renders a batch's status, and its test checks the whole text.
- `0002`: the change: a summary that holds a GitHub token is left out, with a test whose only assertion is `doesNotMatch(…, /ghp_/)`.

Both commits' tests pass.

## Apply

As for [planted-acceptance](../planted-acceptance/README.md#apply), with this folder's patches; the bundle needs no `order.md`.

## Expected findings

| Defect | Expected result |
|---|---|
| `test/status.test.mjs:16` asserts only that `ghp_` is missing | **found**: a finding on that line, introduced: the test passes when `renderStatus` returns `''` or drops the summary line; asks for a positive assertion on the same output |

Findings that may appear and are not wrong: no test of the token pattern's other prefixes, its length or its word boundaries.

A run that misses the negative-only test means a prompt change made the lens weaker. Compare the run with this table in the pull request that changes the prompt.
