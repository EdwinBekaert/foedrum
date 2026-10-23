# The red proof

Recipes with `testFirst` run the Gauger (failing tests), a red proof (a gravity reading with `"expect": "fail"`, read from the repository's structured test report), then Cellarman, whose `testsUnchanged` guard protects the red tests' assertions ([ADR 0017](../../adr/0017-test-first-recipes-and-tasting-lenses.md)).

A red proof's `of` must name a step whose brewer commits; it runs the `test` check and judges the repository's test report, never the exit code, and a brewer with the `testsUnchanged` guard keeps the proven step's tests ([ADR 0078](../../adr/0078-the-red-proof-reads-the-test-report-and-testsunchanged-compares-lines.md), below).

**Red proof needs a test report.** A red proof reads a structured test report, not an exit code: each repository in `foedrum.jsonc` declares `testReport` (TAP or JUnit XML, and where to find it).
A recipe that needs red proof on a repository without one stops at the start of the batch as Stuck (`environment`), naming the fix, before any brewer runs.

**What the red proof reads** ([ADR 0078](../../adr/0078-the-red-proof-reads-the-test-report-and-testsunchanged-compares-lines.md)).
The engine runs the repository's `test` check, removing a report file of a previous run first, then reads the report and what the `of` step committed, from where its first attempt started to its latest success.
The `of` step's tests are the report's tests whose names stand as a whole in a line the step added, as a declaration writes them (`test('adds two numbers'`, `def test_adds(`), so give tests names the runner reports as written.
A name also counts without a runner's parameters (`adds(int, int)[1]` as `adds`), as its part after suite titles (`the calculator > adds two numbers`), and as that part's last part after a class or module (`com.acme.AddTest.adds` as `adds`), which holds no space, so a sentence that ends in a dotted word (`… with git.commit`) counts only as a whole (#406).
The red proof passes when every one of them fails, none passes (a stub must throw, not return a value) or is skipped, and nothing in the report names a load, compile, import or collection error (`SyntaxError`, `Cannot find module`, `ImportError`, `error TS2304`, `errors during collection`, …), not even in one of those tests' own failure: test such an error by asserting on it.
Tests the step did not add may pass or fail on an assertion.

**What `testsUnchanged` keeps** ([ADR 0078](../../adr/0078-the-red-proof-reads-the-test-report-and-testsunchanged-compares-lines.md)).
After an attempt of a brewer with the guard succeeds, the engine compares its commits with what the step its recipe's red proof proves committed.
In each file where that step declared a test, the lines it added that declare a test or assert must still be there as often as before, compared trimmed: moving or reindenting a test within its file is fine, moving it to another file is a change.
Imports, helpers, fixtures, the stubs and new tests change freely.
An attempt that changed them fails, and is retried; a brewer that thinks a test is wrong reports `blocked` with `findings` instead.

## In the engine

Each recipe goes through `resolveRecipe` (ADR 0028), and one that resolves to test-first needs a red proof whose `of` is its first writing step, before any other writing step ([ADR 0064](../../adr/0064-test-first-recipes-when-onblocked-and-a-red-proof-required.md)); the red proof (`"expect": "fail"`) runs the repository's `test` check, ignores its exit code, and reads its structured test report (`testReport` in `foedrum.jsonc`: TAP on stdout or in a file, or JUnit XML) against what its `of` step committed (`git diff` from that step's first attempt to its latest success, in the clone the worktrees were added to, never in an attempt's worktree): it passes only when every test whose name stands in a line the step added fails, none passes or is skipped, and nothing in the report names a load, compile, import or collection error; otherwise it fails and follows its `onFail` route.
A brewer with the `testsUnchanged` guard runs inside `guardTests` (`src/checks/tests-guard.ts`), which fails a succeeded attempt, retryably, that removed a test declaration or assertion the proven step added to one of its test files, compared line by line from diffs it also reads in the clone; and `foedrum serve` refuses every attempt of a batch whose red proof would run in a repository without a `testReport`, so it is Stuck on its environment before a brewer starts ([ADR 0078](../../adr/0078-the-red-proof-reads-the-test-report-and-testsunchanged-compares-lines.md)).
