# 0170. The red proof accepts the regression tests a Gauger names

Date: 2026-10-24 · Status: Accepted · Amends [0017](0017-test-first-recipes-and-tasting-lenses.md) (the Gauger's tests may include regression tests) [0078](0078-the-red-proof-reads-the-test-report-and-testsunchanged-compares-lines.md) (what counts as missing behaviour), [0161](0161-lens-steps-run-a-taster-whose-findings-are-advisory-unless-the-step-blocks.md) (the change input and the status comment) and [0167](0167-a-brewed-pull-request-follows-one-layout-and-opens-as-a-draft-unless-every-taster-approves.md) (the step reports)

## Context
The red proof passes only when every test the proven step added fails because the behaviour is missing ([ADR 0078](0078-the-red-proof-reads-the-test-report-and-testsunchanged-compares-lines.md)).
An order often asks for two kinds of tests: **new-behaviour tests** (`Bash(npm exec *)` is refused), which must fail first, and **regression tests** (`Bash(npm run lint)` stays allowed), which pin what must keep working and pass before the change, as they should.
The red proof knows only the first kind.
In #443's brew (batch `8-1`) the Gauger wrote 16 "stays allowed" tests and named them as regression tests in its commit message, which the engine does not read; `red #1` failed on them, and `gauge #2` then made each of them fail by mixing in a refused rule, so a test named "keeps `Bash(npm run lint)`" tests two cases (#444).

## Decision

### The Gauger's out doc names its tests
- The default Gauger's `output.schema` is `gauge`: the out doc contract with two lists, `tests` (the new-behaviour tests) and `regressionTests`, each a list of one-line names of at most 1,000 characters (the red proof's longest name), at most 200 names, by the name the runner reports; both default to empty.
- A test is a regression test when it pins behaviour the order says stays as it is, and passes before the change; `defaults/brewers/gauger.md` says so.
- Any brewer's out doc that holds a `regressionTests` list of names counts, read leniently: a red proof whose proven step's latest success has none judges as before.

### What counts as missing behaviour
ADR 0078's checks run in this order; the third is new, and the fourth leaves the regression tests out:
1. The run did not bail out.
2. No load, compile, import or collection error anywhere in the report.
3. **Each named regression test is one the step added and passes.** It is the step's when a leaf test of the report has exactly that name, trimmed, and the step added a line that declares it (as ADR 0078 finds the step's tests), in a file where it declared a test and in no comment (a line that starts with `//`, `/*`, `*`, `#` but `#[`, or `--`). A name no such test has fails the proof (`regression test "<name>" is not a test the step added in the report`), and so does one that fails (`regression test "<name>" fails before the implementation: a regression test passes before the change`) or is skipped.
4. **The step's other tests are in the report**: at least one test the step added that is not named a regression test, so a run with regression tests only proves nothing.
5. None of them passed.
6. None of them was skipped.

### testsUnchanged keeps both kinds
A regression test the red proof accepts is one the step added, so `testsUnchanged` already keeps its declaration and assertions, as it keeps every line of the step's tests that declares a test or asserts; Cellarman changes neither kind, and the guard gets no change.

### Who sees the list
- **The test-design lens** checks each named regression test: that it pins behaviour the order keeps, and is not a new-behaviour test named so to pass the red proof.
- A Taster that reviews a diff gets the list in its change input, after the commits and before the diff, which the input's limit cuts ([ADR 0161](0161-lens-steps-run-a-taster-whose-findings-are-advisory-unless-the-step-blocks.md)), when a step of the batch named any; the Gauger reads the lens as its own checklist.
- **The status comment** lists, per step, the new tests and the regression tests of its latest success, as the red proof reads them: its new tests and its regression tests, at most 10 of each with a count of the rest, as it lists assumptions.
- **The pull request's step reports** list both under the step's summary ([ADR 0167](0167-a-brewed-pull-request-follows-one-layout-and-opens-as-a-draft-unless-every-taster-approves.md)), as model text read for secrets.

## Consequences
- A regression test can stand alone: the "stays allowed" case of #443 is a test of its own, named as a regression test, and `red` passes on its first attempt.
- A Gauger could name a new-behaviour test a regression test that passes against a stub returning a value; the red proof cannot tell, since both pass. The test-design lens is the check on that, and the green check still runs it.
- An existing test the Gauger names is refused, also when a comment the step added mentions it: the guard keeps the declarations and assertions the step added in its test files, so a regression test the proof accepts is one whose declaring line the guard keeps, where the guard's declaration patterns read it (a name on a line of its own, as a Java method's after `@Test`, is matched by the proof but kept only through its `@Test` and assertions).
- `tests` is shown, not judged: the red proof still finds the new tests by their declarations.

## Alternatives considered
- **Read the regression tests from the commit message.** Free text; the engine reads no prose.
- **Accept existing tests as regression tests.** The guard would have to keep lines the step never touched, which it cannot find without parsing.
- **Let every passing test the step added count as a regression test.** It would undo ADR 0078's rule that a stub returning a value fails the proof (#46, #47).
