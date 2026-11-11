# 0376. `foedrum init` writes a test line that saves its reports, and doctor and the Maltster read it

Date: 2026-11-11 · Status: Accepted · Amends [0274](0274-the-red-proof-reads-line-coverage-of-the-change-and-a-test-map-not-test-names.md) (where the reports come from: the Brewery's test line, which init sets up for the runners Foedrum knows, and who marks a module `coverage: "none"`), [0298](0298-the-maltster-s-survey-ends-without-a-session-for-a-fresh-map-and-its-check-sends-a-disagreement-back-once.md) (the Maltster reads the Brewery's test line, and names what to add to it when it saves no report), [0199](0199-foedrum-init-writes-a-brewery-s-files-in-its-clone.md) (the `test` line init proposes for a Node repository, and the line it adds report flags to when the person types one) and [0017](0017-test-first-recipes-and-tasting-lenses.md) (its "most test runners can produce TAP or JUnit XML", replaced by what was checked per runner)

## Context
The red proof and the uncovered check read two files a test run saves: a test report and, where the module has a coverage tool, a coverage report; the test map says where they are ([ADR 0274](0274-the-red-proof-reads-line-coverage-of-the-change-and-a-test-map-not-test-names.md), [ADR 0297](0297-the-red-proof-reads-a-test-map-only-and-a-test-first-batch-with-none-is-stuck-before-its-first-step.md)).
Nothing in Foedrum got them written (#856):
- `foedrum init` wrote plain `npm test` as a Node repository's test line, with no reporter settings.
- The Maltster read the repository's scripts and CI, not the Brewery's test line, which is what Foedrum runs; so a person who fixed that line and retried met the same block.
- `foedrum doctor` said "Foedrum has everything it needs" with no report in reach.

The self-brew trial (#374) hit it on its first order: the Maltster blocked at `survey`, after spending tokens, with "The repository's test command writes no test report or coverage file".
ADR 0017's "most test runners can produce TAP or JUnit XML" and ADR 0274's "the target repository brings its coverage tool" were assumptions, with no alternative weighed.

What was run, once, by hand, outside any test (Node 24.20.0, vitest 3.2.7, in a scratch folder):
- `node --test` reads a flag after its first file as the test's own argument: `npm test -- --test-reporter=junit …` over the script `node --test test/*.test.mjs` exited 0 and wrote nothing.
  With the flags right after `--test`, `--experimental-test-coverage --test-reporter=junit --test-reporter-destination=junit.xml --test-reporter=lcov --test-reporter-destination=lcov.info` wrote both files.
- node does not create a destination's folder: `--test-reporter-destination=.foedrum/test-results/junit.xml` failed with ENOENT, exit 7.
- Once a `--test-reporter` is given, node prints nothing to the console unless `--test-reporter=spec --test-reporter-destination=stdout` is given too.
- vitest reads its flags after `npm test --`: `--reporter=default --reporter=junit --outputFile.junit=junit.xml` wrote the report, creating its folder.
  `--coverage` without its package stopped with `MISSING DEPENDENCY Cannot find dependency '@vitest/coverage-v8'`.

What was read in the tools' docs, not run (pytest and `dotnet test` were not installed where this was written):
- pytest writes JUnit XML with `--junit-xml=<path>` (its docs' form); coverage needs pytest-cov, `--cov --cov-report=lcov:<path>`.
- `dotnet test` writes JUnit only with the JunitXml.TestLogger package in each test project, `--logger:"junit;LogFilePath=TestResults/{assembly}.junit.xml"`, the path relative to the test project; coverage needs coverlet.collector, `--collect:"XPlat Code Coverage"`, which writes `coverage.cobertura.xml` under `TestResults/<guid>/`, and which dotnet's xunit, nunit and mstest templates reference.
- `dotnet test --logger trx` needs no package, but the check runner refuses a TRX module today ("which Foedrum does not read yet", `src/checks/check-runner.ts`).

## Decision
The maintainer settled four points on 2026-11-11 (#856, its decisions comments).

### Foedrum changes only the Brewery's test line, never the repository's files
- **One reading of a test line**, `readTestLine` in `src/checks/test-line.ts`, shared by init and doctor: it reads the line's words, quotes taken off, and never runs it.
  It knows four runners: `node … --test`, `vitest`, `pytest` (also as `python -m pytest`) and `dotnet test`, each by its program's name in any case, with a folder or a Windows extension (`Node.exe`, `pytest.exe`).
  A line whose unquoted `;`, `|`, `&` or line break joins it to another command is read as a runner Foedrum does not know: init never edits a line it cannot read whole.
  A report counts as saved when the line names a JUnit or TAP reporter with a file for it: for node a `junit` or `tap` reporter whose destination, paired with it by position as node pairs them, is not `stdout` or `stderr`; for vitest `--outputFile.junit`, or a plain `--outputFile` beside a `junit` reporter; each flag read as `--flag=value` or `--flag value`.
  The words are read with POSIX sh's quotes, `'` and `"`, on every platform; cmd.exe, which runs a Windows line, takes no `'` as a quote, so a Windows line that quotes `;`, `|` or `&` in single quotes is read as one command where cmd runs two. Such a line was already broken on Windows; the reading does not model cmd's quoting.
  For each it says whether the line saves a test report already, the line with the flags that would, where flags alone can, and what needs a package.
- **Reports at the worktree root**: `junit.xml`, and for node `lcov.info`, since node cannot write into a folder that is not there.
  One test line is one run, so the Maltster names these paths for the module that run covers.
- **What init writes.**
  - A Node repository whose `test` script is `node --test …`: the script itself as the line, the flags inserted right after `--test`, with node's console output kept. node needs no package for either report.
    A script that already names a `--test-reporter` or a destination of its own is kept as it is, with a note on what to add: node refuses a line whose reporters and destinations do not pair up (`ERR_INVALID_ARG_VALUE`, ran once on Node 24.20.0), so the flags cannot simply be put in front.
    A repository with a `pretest` or `posttest` script keeps `npm test`, with a note naming the flags to add right after `--test` in its test script: the script's own text would skip what npm runs around it, such as a `tsc` build before `node --test dist/`.
    The line init writes runs without what `npm test` adds, its `pretest` and `posttest` aside: `node_modules/.bin` is not on its PATH, so a test that starts a locally installed tool by name needs `npm test` kept.
  - One whose `test` script runs vitest: `npm test -- --reporter=default --reporter=junit --outputFile.junit=junit.xml`, and a note naming `@vitest/coverage-v8` and `--coverage --coverage.reporter=lcov`.
  - Any other Node script: `npm test`, as before.
  - A line the person typed (a repository without `package.json`, or a proposal they did not use): with `--junit-xml=junit.xml` after a pytest line, the node or vitest flags after one of those, and a note naming pytest-cov; a `dotnet test` line as it is, with notes naming JunitXml.TestLogger and coverlet.collector and their flags.
  - A line whose runner it does not know: as it is, with `test line: Foedrum does not know this test runner and added no report settings; …`.
  - Init prints the line and its notes under the proposal it already asks the person to confirm, and asks nothing new.
- **Init writes no `testReport`.** The check runner reads it only to find a report written outside the map (ADR 0297); the test map owns where the reports are.

### A runner that needs a package for coverage still brews
- Init writes no test map: the Maltster does (ADR 0274).
  When the test line saves a test report and no coverage report, the Maltster maps the module with `"coverage": "none"` and names in its out doc the package and flags that would measure it.
- The status comment already says so: `not measured, coverage none: <modules>` for a module whose code the change touched, and `Adds test map modules with coverage none: …` for a module the batch's map adds (ADR 0274).
- What a person gives up with `"coverage": "none"`: the uncovered-line check skips the module, so a changed line no test runs is the test-design lens's and Brett's to find, not a failed step. The red proof still runs.

### `foedrum doctor` reads the test line, never runs it
- When the Brewery's recipes include one that proves its tests red (its `testFirst`, as the loader resolves it, ADR 0017), doctor reads each repository's `test` check, on this platform's line, with `readTestLine`. It runs no repository code, as before (`src/cli/doctor-facts.ts`).
- A known runner whose line saves no test report is an **optional problem**: `the test line of <repo> saves no test report, which recipe <names> proves its tests with`, whose fix is the line to use, or for `dotnet test` the packages and flags.
  doctor then ends "Foedrum can run; the problems above are optional.", no longer "Foedrum has everything it needs".
- A runner it does not know is a **notice**: it cannot tell, and the survey of the first test-first order checks it.
- The loader lists its test-first recipes by name (`testFirst` on `loadRecipes`'s result) for doctor to name them.

### The Maltster reads the Brewery's test line
- A new input source, `from: "test-line"`: the `test` check `foedrum.jsonc` gives the attempt's repository, as written, or each platform's line of it, named (`run: …`, `windows: …`).
  It is left out where the attempt has no repository of its own (a Brewery order's folder of checkouts) or the repository has no test check.
  It reaches the brewer between the nonce tags, as an input of its own, `source="the Brewery's test line for <repo>"` ([ADR 0041](0041-untrusted-input-in-per-prompt-nonce-tags.md)).
  The line is the person's own `foedrum.jsonc`, reaching their own brewer as written: no secret scan reads it.
- The default Maltster (version 4) names it as `testLine`. Its prompt says that line is what runs; when it saves no test report, the Maltster ends blocked on the environment and names what to add to the Brewery's test line in `foedrum.jsonc`, never the repository's files.

**Brewery migration:** none. Foedrum has no release, so no Brewery depends on the old behaviour; an existing Brewery's `foedrum.jsonc` stays valid, and `foedrum doctor` names a test line that saves no report.

## Consequences
- A newcomer whose repository runs `node --test` gets a test line that saves both reports from `foedrum init`, and a first test-first order that does not stop at the survey for want of a report.
- A vitest or pytest repository brews with `"coverage": "none"` until its package is added; a `dotnet test` repository needs two packages before its first test-first order, which init and doctor name.
- doctor no longer says it has everything it needs over a test line that saves nothing.
- A Maltster that blocks for want of a report names the Brewery's line to change, so the fix and the retry meet.
- The runners Foedrum recognises are a list in one file; jest, mocha, cargo and go get the notice until a decision adds them.

## Alternatives considered
- **Change the repository's files** (its `package.json` scripts, a `vitest.config`, a `pytest.ini`). Not taken: the repository is its owners', and a person confirms the Brewery's lines (ADR 0023).
- **doctor runs the test line once.** It would run repository code on the person's machine outside the check sandbox, which doctor has never done.
- **Add `--logger trx` for `dotnet test`.** It needs no package, but Foedrum refuses a TRX module today, so the stop would move from the survey to a Stuck run. A TRX reader is a decision of its own.
- **Reports under a folder** such as `.foedrum/test-results/`. node does not create the folder, so the line would need a step to make it, and a line of two commands is what init does not read.
- **Init writes `coverage: "none"`.** Init writes no test map; the Maltster does, with the line in front of it.
- **A doctor notice instead of an optional problem.** It would keep "Foedrum has everything it needs" over a line that saves nothing, the false all-clear #856 names.
- **Scan the test line for secrets before the Maltster reads it.** It is the person's own configuration reaching their own brewer, and nothing has gone wrong there.
