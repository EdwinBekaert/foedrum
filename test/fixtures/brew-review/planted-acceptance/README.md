# Planted-defect sample for the acceptance lens

An order and a change made for it, used to check `defaults/lenses/diff/acceptance.md` after a prompt changes (CLAUDE.md, Tests; [ADR 0197](../../../../docs/adr/0197-acceptance-ships-as-a-default-diff-lens-and-nip-tastes-through-it-beside-correctness.md)). The change passes correctness: what it builds works. But it leaves one item of the order's checklist unbuilt and builds one thing the order did not ask for. The files are data: no test applies them. The [planted-demo](../planted-demo/README.md) sample checks the other lenses.

- `order.md`: the order's issue text, its title on the first line, with a "What to build" checklist of three items and a "Later" section that is not part of the checklist.
- `0001`: the base, a tiny repository with `greet.mjs`, its test and a README.
- `0002`: the change, as a brewer would make it for the order.

## Apply

In an empty folder under `.foedrum/tmp/` (the read guard lets a reviewer read only inside the checkout, ADR 0049):

```sh
git init -q -b main .
git am <checkout>/test/fixtures/brew-review/planted-acceptance/*.patch
git diff HEAD~1 HEAD > diff.patch
```

Then start one `taster` subagent with `.claude/skills/brew-review/reviewer-prompt.md` filled in for the acceptance lens, with that folder as `<checkout>` and a bundle that holds `diff.patch`, `commits.txt`, `files.txt` and `order.md` (the copy here) beside the criteria. Or run the default Taster's prompt with the order as its `order` input.

## Expected findings

Line numbers are in `greet.mjs` after `0002`.

| Item or change | Expected result |
|---|---|
| `greet("")` returns "Hello, stranger!" | **built**, `greet.mjs:2`; not a finding |
| a test pins down the greeting of a visitor with no name | **built**, `greet.test.mjs:9` to `11`; not a finding |
| README.md says how a visitor with no name is greeted | **missing**: a finding, `major` or `minor`, introduced, naming the README; the change leaves `README.md` as it was |
| `farewell` (lines 5 to 7) | **not asked for**: a finding, `minor` or `major`, introduced |
| "A greeting in the visitor's own language" | not an item (under "Later"): no finding; at most a follow-up proposal in the notes |

The verdict is `changes` when the missing item is `major`, else `approve`. The notes list the three items, each with its verdict and line.

Findings that may appear and are not wrong: `farewell` has no test (that belongs to test design, not to this lens).

A run that misses the missing README item or the unasked `farewell` means a prompt change made the lens weaker. Compare the run with this table in the pull request that changes the prompt.
