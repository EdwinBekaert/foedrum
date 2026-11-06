# 0342. A test the Gauger names that the run does not report is said to be not proven

Date: 2026-11-06 · Status: Accepted · Amends [0170](0170-the-red-proof-accepts-the-regression-tests-a-gauger-names.md) (its `tests` and `regressionTests` are read against a run, and judge nothing), [0225](0225-a-ready-pull-request-gets-a-merge-brief.md) (the brief's Risk left says so), [0274](0274-the-red-proof-reads-line-coverage-of-the-change-and-a-test-map-not-test-names.md) (names matter to what a person is told, never to a verdict; the red proof's reason counts them) and [0297](0297-the-red-proof-reads-a-test-map-only-and-a-test-first-batch-with-none-is-stuck-before-its-first-step.md) (the Gauger's prompt asks for names as the runner reports them)

## Context
In the self-brew trial (#374), a test the Gauger listed went unjudged: the Brewery's test line ran `npm test`, which does not run `test/integration/`.
Reproduced through `foedrum serve` on the fake host, with a Gauger that names one test under `test/unit/` and one under `test/integration/`:
- the red proof passes on the unit test that fails, and says nothing of the other;
- the green check passes, and says nothing of it;
- with neither test in the run, the red proof already fails (`no test fails, so none shows the behaviour missing`), without saying why none failed.

Since ADR 0274 the red proof reads no names, so nothing compares what a Gauger says it wrote with what the run reported.
A report holds every test that ran by name, passing or not, while its places are partial (node's TAP places only a failing test, and a changed file in a test area may be a helper), so names are the only full reading of what a run reported.

## Decision

### What is read
- A red proof, and a check step whose test check exited 0, compare the names in the out doc of the Gauger's latest success with every test of the reports the effective map's modules wrote (`src/checks/named-tests.ts`).
- A name counts as reported when, on one line, a report's name holds it as whole words (`math > adds`, `Acme.Math.Adds(a: 1)`, `test_adds[1]`), or it ends with a report's name as whole words (`math > adds`, `tests/test_math.py::test_adds`), case kept, whatever the test's result.
- The names are read only when every module's reports were read.
  A module that wrote none, a TRX report (#727) and a report that cannot be read say nothing of a name, so nothing is recorded.
  So does a comparison past its limit of work, 2^28 characters, about a second: a name that repeats inside a report's name is tried at each place, and a brewer writes both, so the driver is never held for minutes with no deadline to stop it.
  A repository with no report therefore starts failing nothing: no map is Stuck before the first step (ADR 0297), a base module with no report is already a load error at red, and at green the run is only read for what it holds.
- A check step whose test check failed is not read, since it may have stopped before a test; one whose tests passed and that failed on something else is ([ADR 0280](0280-a-new-module-is-judged-unreached-only-on-a-passing-test-run.md)).
  A red run fails by nature, and a runner told to stop at its first failure can stop before a named test, so what a red proof records is provisional: the green check's run replaces it.

### What is recorded
- `step.finished` gains `unreported: { tests, more }`, on a proof that passed and a check step: the first 10 names, kept as a failing test's name is ([ADR 0304](0304-a-failed-test-reading-names-its-failing-tests-from-the-test-map-s-reports.md): one line, cut to 200 characters, left out when it looks like a secret), and a count of the rest.
- An empty list says the reports were read and hold every name; no field says they were not read, or that no test was named.
- Of a batch's path, the latest attempt with the field decides, so a later run that holds the names takes the line off, one that does not brings it, and a run not read leaves it.
  The merge brief reads only the steps of the batch's current recipe, as each of its lines does ([ADR 0327](0327-a-pass-over-one-batch-s-effects-that-throws-stops-no-other-batch.md)).
  A later batch of the order has a path of its own, and starts clean.

### What is said
- One line in the status comment, after the stale map's, and one under the merge brief's **Risk left**, each name told as a finding's text is:

  > Not proven: the test run reports no test named: adds through the real tool, rejects %s and 3 more

- It never says a test did not run: a report cannot show that, and a name can miss a test that ran.
  A template name such as `rejects %s` reads as unreported, and nothing fails.
- A red proof with no failing test, or whose failing tests lie in no changed test file, adds to its reason along `onFail`, on the same route and with the same Stuck after it: `the run reports no test named as 2 of the 3 tests step gauge named, so "npm test" may not run them`.
  A count, with no name: the reason reaches a route input and a comment.
- A recorded name reaches no prompt: route inputs read the reason, and a `checks` input reads the readings.

### Why a line, and no failure
- The order's migration asks that a repository whose integration tests run under another command keeps working and is told.
- Names were dropped from verdicts for their false positives (ADR 0274), and a template name cannot match.
- A Gauger sent back for a name it wrote differently has nothing to commit, which is a divergence since ADR 0297 withdrew the names-only `done`.

**The cost.** A batch whose Gauger names one test that fails and one the test line does not run reaches a person with that test unproven: a line says so, and nothing stops it.
A repository whose CI runs those tests still runs them on the pull request, whose checks the batch waits for ([ADR 0213](0213-an-open-pull-request-s-checks-on-its-head-are-recorded-once-they-finish.md)); one whose CI does not has only the line.

### The Gauger's prompt
- Version 10 of the default Gauger says that the test check runs one line, which may not run every folder of a test area, and to read the repository's scripts and CI for what its usual test command runs.
- The map says where tests live, not what the line runs, and the Gauger gets no `test` command (see the alternatives).
- "by the names the runner reports" stays in the prompt, though ADR 0297 says the prompt no longer asks for them.
  That sentence of ADR 0297 was not carried out when it was written, and the names now matter to what a person is told.

## Migration
- **A running Brewery need do nothing.** The line is the engine's, and works with any Gauger that names its tests, also one of the Brewery's own.
- **A Brewery with its own `gauger.md`** gets the prompt's guidance only by adding this line to its rules, and bumping its `version`:

  > **Tests go where the test check reports them.** The red proof and the green check read one run, of the repository's `test` check, through the reports the test map names. A test area may hold tests that line does not run, such as integration tests under a command of their own: read the repository's scripts and CI, and put each test where its usual test command reaches it. A test you name that the run reports under no name is listed as not proven in the status comment and the merge brief; it fails nothing.

- **A repository whose tests the line misses** may do any of these, and need do none: have its `test` line run them, as a module with a report of its own in the test map; leave their folder out of the map's test areas, so a Gauger is steered away from it, at the price that `testsUnchanged` no longer keeps a test put there.
- **Foedrum's own Brewery has nothing to do.** Adding `test:integration` to its test line is not worth it: it takes over ten minutes and times out under load, and CI runs those tests on every pull request. Leaving `test/integration/` out of its map's test areas is not worth it either, since `testsUnchanged` would then keep no test put there.
- **An older Foedrum cannot read a store with this field**: `step.finished` is a strict schema, so a state branch that holds `unreported` refuses an older version, as each new field of the event does.

## Consequences
- A named test the reports do not hold is visible while the batch brews and in the merge brief.
- A red proof with no failing test says what may be the reason.
- A check step's passing test run reads its reports once more when a Gauger named tests.
- `tests` is still shown and judges nothing; `regressionTests` likewise.

## Alternatives considered
- **Fail the red proof on an unreported name.** See above: it stops a repository the order says keeps working, on a reading that can be wrong.
- **Fail it only where the reports place every test and a changed test file holds none.** Stronger evidence, but it catches node's JUnit and not its TAP, costs about 40 lines, and brings back the names-only `done`.
- **Read by file alone, with no name.** A helper or a fixture in a test area holds no test, so it reads as a test file no run reached.
- **Send the Gauger back once, then go on.** A repository whose tests legitimately run elsewhere pays for a Gauger session on every such batch.
- **Record on a failed red proof too.** The proof's reason already counts them, and the attempt after it replaces the run.
- **Give the Gauger the repository's `test` command as an input.** Not built: it is a new input kind, and the prompt with the recorded line already covers a Gauger that puts a test where the run does not reach it. A real batch whose Gauger read the scripts and CI and still put a test out of reach would justify it.
- **Name the tests in the red proof's reason.** Model text in a route input and a comment, which the Gauger that wrote it does not need.
