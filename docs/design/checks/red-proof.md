# The red proof

> The coverage readers `src/formats/lcov.ts` and `src/formats/cobertura.ts`, with `src/formats/coverage-files.ts` reading LCOV by file and Cobertura as every `coverage.cobertura.xml` under a folder pattern (each file a regular one of at most 16 MiB, as ADR 0078 reads a test report), give the [uncovered-line check](test-map.md) a `CoverageReport` of each file's lines (paths relative to the worktree's root with `/`, its root compared in either case on every system, since a folder beside the worktree that differs only in case is no layout a tool runs in, a file outside it left out, and of several Cobertura `<source>`s the one whose file is in the worktree) with their hits and, where the tool writes them, branches taken of total; reports and classes merge by the most hits per line and the branch count with more taken, so two runs that took different halves of a branch show the higher count, not their union.
> Not in the readers: the cap on how many files a folder pattern may match, and the refusal of a report path or pattern that leads out of the worktree by its real path (ADR 0274), which the test map and the uncovered-line check put around them.

Recipes with `testFirst` run the Gauger (failing tests), a red proof (a gravity reading with `"expect": "fail"`, read from the test reports the repository's [test map](test-map.md) names), then Cellarman, whose `testsUnchanged` guard protects the red tests ([ADR 0017](../../adr/0017-test-first-recipes-and-tasting-lenses.md)).

A red proof's `of` must name a step whose brewer commits; it runs the `test` check and judges the test reports, never the exit code nor a test's name, and a brewer with the `testsUnchanged` guard keeps the lines the proven step added to the map's test files ([ADR 0274](../../adr/0274-the-red-proof-reads-line-coverage-of-the-change-and-a-test-map-not-test-names.md), below).

**A red proof needs a test map** ([ADR 0297](../../adr/0297-the-red-proof-reads-a-test-map-only-and-a-test-first-batch-with-none-is-stuck-before-its-first-step.md)).
A recipe whose red proof would run, in a repository whose map is missing where the batch started, stops at the start of the batch as Stuck (`environment`), naming the fix, before any brewer runs:
- the Brewery keeps the map (`"testMap": "brewery"`) and has no `test-maps/<owner>/<name>.jsonc`: `recipe <recipe> proves its tests red, which needs a test map of <repo>: the Brewery keeps it and has none, so add test-maps/<owner>/<name>.jsonc to the Brewery (ADR 0297)`, whether the recipe has a survey or not, since a survey cannot write the Brewery;
- the repository keeps it, has no `.foedrum/test-map.jsonc`, and the recipe runs no survey check: `recipe <recipe> proves its tests red, which needs a test map of <repo>: commit .foedrum/test-map.jsonc to <repo>, or add a survey step to the recipe (ADR 0297)`.

Where the recipe runs a survey check and the repository keeps its map, the survey proposes one before the Gauger ([the test map](test-map.md), [ADR 0298](../../adr/0298-the-maltster-s-survey-ends-without-a-session-for-a-fresh-map-and-its-check-sends-a-disagreement-back-once.md)).
A red proof that still finds no map, at the base nor at its tip, is Stuck the same way.

**Regression tests.**
A test that pins behaviour the order keeps passes before the change, as it should; the Gauger names it in its out doc's `regressionTests` (the schema `gauge`).
The red proof does not judge the names: a passing test is just a passing test.
The pull request lists them, and the test-design lens checks that each one pins behaviour the order keeps: a Taster that reviews a diff gets the list in its change input ([tasting](../recipes/tasting.md)).

**A test the Gauger names that the run does not report** ([ADR 0342](../../adr/0342-a-test-the-gauger-names-that-the-run-does-not-report-is-said-to-be-not-proven.md)).
A red proof, and a check step whose test check exited 0, compare the names of the Gauger's latest success with every test of the modules' reports (`src/checks/named-tests.ts`), when every module's reports were read; it judges nothing.
`step.finished` keeps `unreported`: the first 10 names as a failing test's are kept, and a count of the rest, an empty list when the reports hold them all.
The latest attempt on the batch's path with that field decides one line, in the status comment and under the merge brief's Risk left: `Not proven: the test run reports no test named: a, b`.
A red proof with no failing test, or none in a changed test file, adds to its reason how many it does not hold, and no name.

**What `testsUnchanged` keeps** ([ADR 0274](../../adr/0274-the-red-proof-reads-line-coverage-of-the-change-and-a-test-map-not-test-names.md)).
After an attempt of a brewer with the guard succeeds, the engine compares the test files at its branch with what the step its recipe's red proof proves committed.
Every line that step added to a separate test file of the effective map, from the maps at the base the batch's change starts from and at the proven step's tip, must still be there as often as before, compared trimmed, blank lines aside: imports and helpers included, so an edited import line fails the attempt too.
The guard counts each line in the file as the attempt's branch holds it and as it was where the proven step started, read in the clone (`git --literal-pathspecs ls-tree`, then `git cat-file` of the blob it names, each bounded as a diff is): a line is lost when the tip holds fewer copies than the file held before plus the copies the step added, so a later step that removes its own copy of a red line, such as a `});` of a test it added, keeps the red step's copy, and an older test's copy hides no removed red one; a file gone at the tip loses every line.
The effective map keeps every module the base lists, and the proven step's map may add modules, so a later attempt's edit of the map narrows nothing.
A file in no test area of the map, and a module whose tests are `inline`, are not guarded by its lines; the test-design lens judges inline tests against the red diff.
A map that cannot be read at either commit blocks the attempt on its environment, and so does no map at both ([ADR 0297](../../adr/0297-the-red-proof-reads-a-test-map-only-and-a-test-first-batch-with-none-is-stuck-before-its-first-step.md)).
Moving or reindenting a line within its file is fine, moving it to another file is a change, and new tests change freely; so do fixtures and stubs outside the map's test areas, while a fixture the red step added in a test area is kept line by line too.
An attempt that changed them fails, and is retried; a brewer that thinks a test is wrong reports `blocked` with `findings` instead.

## With a test map

The red proof reads the test map the base or its tip has, and no test names ([ADR 0274](../../adr/0274-the-red-proof-reads-line-coverage-of-the-change-and-a-test-map-not-test-names.md)).
The base is taken as green, so a test that fails after the proven step failed because of it, and a test that passes, such as a regression test, is just a passing test.

**The run.** The engine reads the map at the batch's base (the base it merged, else where its change starts) and at the red proof's tip, and builds the [effective map](test-map.md): a base map that cannot be read makes the batch Stuck (`environment`), and a tip map that cannot be read fails the step for its `onFail` route.
A module whose test report is TRX makes the batch Stuck (`environment`) before the run: Foedrum reads no TRX yet, so its tests write JUnit XML to a file the map names instead.
Every test report and coverage report path and folder pattern of the effective map is looked for and removed before the run, so a report an earlier run left never stands for this one; a pattern that is refused or a path that cannot be removed makes the batch Stuck (`environment`).
The repository's confirmed `test` line runs once, and each module's test report is read where the map says, each file its pattern matches; stdout is not read, and neither is `testReport` from `foedrum.jsonc`.
A report that cannot be read, or is not in its format, fails the red proof; a test report pattern that matches a folder makes the batch Stuck (`environment`), naming the file to give, since a brewer's commit cannot fix the map's confirmed layout.

**The checks**, in this order, the first that fails naming why (`the red proof of step <of> failed: <why>`):
1. no report bailed out;
2. no load, compile, import or collection error: a text in the reports or in a failing test's own failure that names one (`SyntaxError`, `Cannot find module`, `ImportError`, `error TS2304`, `errors during collection`, `System.IO.FileLoadException : Could not load file or assembly`, …; .NET's load failures as an exception's text, by full type name, [ADR 0269](../../adr/0269-the-red-proof-refuses-net-s-assembly-and-type-load-failures.md)), so test such an error by asserting on it; and a module the base's map lists that wrote no test report, or no coverage report where its coverage is not `none`, counts as one; a module only the batch's map lists that wrote none is left to [the unreached rule](test-map.md), which judges it after a passing run;
3. the step changed a file in a test area of the effective map, or in a module whose tests are inline;
4. a test fails, and when the report places every failing test, one of them lies in a file the step changed in such an area: by file, since a report places a test at its declaration, so a row added to a table fails at a line the base had. A failing test the report does not place may be the step's, so the check holds only when every failing test is placed: a reading of ADR 0274's check 4, which says "where the report gives a failing test's location";
5. no skipped test lies, by the report's own place for it, in a line the step added: by line, so a platform skip the base had in a file the step added a test to is not the step's.

**Where a report places a test.** Only the report says, never the source: TAP's diagnostic `location` (a file, a line and a column) and JUnit's `file` and `line` attributes.
node 24 writes a TAP location on a failing test only, not on a skipped one, and its JUnit report a `file` on every test and no `line`; so check 4 reads both, and check 5 reads only writers that give a skip its line, such as pytest's JUnit.
ADR 0274 says node's TAP gives a location for a failing or a skipped test; node 24.20 does not, as captured when this was built (#709), so in a node repository a skip the step adds is the test-design lens's to find.
A skip the report places on no line, a failure only in older tests where no location is given, and a stub that lets one new test pass are the [test-design lens](../../../defaults/lenses/diff/test-design.md)'s to find.
A report's absolute path is made relative to the worktree's root, or to its real path, where a run the check sandbox starts writes it when a link leads to the worktree (macOS's `/tmp`, a junction); a relative path, which a runner may write from a module's folder (pytest from its rootdir), names a changed file whose path ends with it, of the module whose report holds it.
Paths are compared with git's in git's case, folding case on Windows and macOS (`foldsCase`).

## In the engine

Each recipe goes through `resolveRecipe` (ADR 0028), and one that resolves to test-first needs a red proof whose `of` is its first writing step, before any other writing step but a survey whose brewer names `testMapOnly` ([ADR 0064](../../adr/0064-test-first-recipes-when-onblocked-and-a-red-proof-required.md), [ADR 0298](../../adr/0298-the-maltster-s-survey-ends-without-a-session-for-a-fresh-map-and-its-check-sends-a-disagreement-back-once.md)); the red proof (`"expect": "fail"`) runs the repository's `test` check and ignores its exit code.
`proveRed` and `proveMapped` in `src/checks/check-runner.ts` read every module's report against what the `of` step committed (`git diff` from that step's first attempt to its latest success, in the clone the worktrees were added to, never in an attempt's worktree), and `judgeMapped` in `src/checks/red-proof.ts` judges the five checks above (`skipsInAddedLines` is check 5); a failed check follows its `onFail` route.
A brewer with the `testsUnchanged` guard runs inside `guardTests` (`src/checks/tests-guard.ts`), which fails a succeeded attempt, retryably, that removed a line the proven step added to a separate test file of the test map, compared line by line with the test files at the attempt's tip, read in the clone, with the maps (`testMaps`, `src/checks/test-map.ts`).
The guard is the attempt's brewer's, in the recipe the attempt was scheduled under, and the step it keeps the tests of is the one the batch's recipe proves red ([ADR 0310](../../adr/0310-the-driver-wiring-finds-an-attempt-s-brewer-in-the-recipe-it-was-scheduled-under.md)).
`foedrum serve`'s step runner (`refuse` in `src/cli/driver-wiring.ts`) blocks every attempt of a batch whose red proof would run and whose map is missing on its environment, before a brewer starts, unless the recipe runs a survey check and the repository keeps its map: it knows a Brewery's map from its files, and reads a repository's with git where the attempt started, so a retry after the map is committed reads it, and only while no attempt there has succeeded, after which the red proof and the guard name a missing map (`refusalCommit`, `src/checks/test-map.ts`), the attempt waiting for the read (`stepRunner`, `src/engine/step-runner.ts`; a stop meanwhile cancels it) ([ADR 0297](../../adr/0297-the-red-proof-reads-a-test-map-only-and-a-test-first-batch-with-none-is-stuck-before-its-first-step.md)).
