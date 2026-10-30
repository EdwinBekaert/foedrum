## Review: `544-pr-checks` @ `da68e24b`

Base `f564d079` · 16 commits · lenses: acceptance, correctness, cross-platform, design-conformance, necessity, security, test-design (two rounds for correctness, security, design-conformance, test-design)

### Lens findings

Round 1: 13 findings: 0 blocker, 6 major, 7 minor; 0 pre-existing. Round 2 (correctness, security, design-conformance, test-design over the change since `1830ee9e`): 10 findings: 0 blocker, 2 major, 8 minor; 0 pre-existing.

| # | Lens | Severity | Location | Finding | Disposition |
| --- | --- | --- | --- | --- | --- |
| 1 | acceptance | major | `CLAUDE.md:115` | CLAUDE.md's engine rule does not name the checks wait as a written exception | dismissed because CLAUDE.md follows in the consultant's docs PR after the merges (the ma … |
| 2 | correctness | major | `src/engine/pr-checks.ts:94` | A finished record was final, but a re-run or a late check can change a head's checks | fixed in `8cd3a396` (red), `3dc99a04`: every open head is read on every pass and recorde … |
| 3 | correctness | minor | `src/engine/status-comment.ts:278` | The checks line stayed after someone else pushed to the branch | fixed in `8cd3a396`, `3dc99a04` |
| 4 | security | minor | `src/schemas/events.ts:60` | A check's link had no length bound | fixed in `8cd3a396`, `3dc99a04`: at most 2,000 characters, a longer one left out |
| 5 | design-conformance | major | `CLAUDE.md:115` | CLAUDE.md and pause.md still call the pause the one exception | pause.md fixed in `57bbbf25` ("one exception", links invariants); CLAUDE.md dismissed as … |
| 6 | design-conformance | major | `docs/adr/0213-…:28` | The ADR and the page named a "blocked sub-order (ADR 0211)" that was not on main | fixed in `57bbbf25` (removed; #541's ADR 0211 is now on main, and the merge of main name … |
| 7 | design-conformance | minor | `docs/adr/0213-…:3` | The status line did not amend ADR 0202 | fixed in `57bbbf25` |
| 8 | test-design | major | `src/engine/pr-checks.ts:102` | No test of a moved head while the head before was pending | fixed in `a0f17159` (regression tests, no-checks and running cases) |
| 9 | test-design | major | `src/engine/status-comment.ts:286` | No test of failed checks that all lack a link | fixed in `a0f17159` |
| 10 | test-design | minor | `src/engine/status-comment.ts:278` | No test of a record for an ended pull request | fixed in `a0f17159` |
| 11 | test-design | minor | `src/github/checks.ts:28` | No test of the surrogate cut | fixed in `a0f17159` |
| 12 | test-design | minor | `test/unit/events.test.ts:314` | The schema tests listed as regression tests pin new behaviour | dismissed with the red-proof blocker, by the user (below) |
| 13 | simplify | — | — | (see Simplify) | applied in `1830ee9e` |
| 14 | design-conformance (r2) | major | `CLAUDE.md:115` | Same as #1 | dismissed as #1 |
| 15 | design-conformance (r2) | minor | `docs/design/humans/pause.md:22` | pause.md's `--all` list leaves out the checks read | fixed in `c49bd23c` (and ADR 0213's amendment of 0202 says so) |
| 16 | design-conformance (r2) | minor | `docs/design/intake/README.md:12` | The intake index row leaves out the checks | fixed in `c49bd23c` |
| 17 | design-conformance (r2) | minor | `src/schemas/events.ts:570` | The event comments said "recorded once per head" | fixed in `c49bd23c` |
| 18 | security (r2) | minor | `src/engine/pr-checks.ts:112` | No limit on how many records one head can append | dismissed because the flood needs the statuses permission on the repository Foedrum brew … |
| 19 | correctness (r2) | minor | `src/engine/status-comment.ts:295` | The failed count leaves out failed checks cut into `more` | fixed in `9cb6c903` (red), `584da1e8`: says "at least" when every kept check failed and … |
| 20 | test-design (r2) | major | `src/engine/pr-checks.ts:112` | No test sees the pass's own skip of an unchanged finished head | fixed in `de32a79f` (asserts no failure is reported after repeated passes) |
| 21 | test-design (r2) | minor | `src/engine/fold.ts:194` | No test pins `more` in `sameHeadChecks` or the `more > 0` boundary | fixed in `de32a79f` (exactly 100 checks, then one more) |
| 22 | test-design (r2) | minor | `src/cli/serve.ts:288` | No test pins that `serve` gives the intake its reader | dismissed because it is one line of wiring and `test/unit/serve.test.ts` is already over … |
| 23 | test-design (r2) | minor | `test/unit/events.test.ts:315` | Same as #12 | dismissed as #12 |

Verdicts, round 1: acceptance request_changes · correctness request_changes · cross-platform approve · design-conformance request_changes · necessity approve · security approve · test-design request_changes. Round 2: correctness approve · security approve · design-conformance request_changes (CLAUDE.md, dismissed) · test-design request_changes (fixed or dismissed above).

Design decision taken in the round (finding #2), agreed with foedrum-consultant: the latest record of a head's checks is how they stand now, never final; ADR 0213 says what that means for #546, #549 and #551.

### Mutation check (Brett)

0 min 20 s · round 1: 2 test files (direct) · round 2: not needed
<sub>Generated by the `/brew-review` skill (ADR 0017).</sub>
