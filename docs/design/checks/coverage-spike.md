# Line coverage for the red proof (spike #618)

> **A spike's findings, not a decision.**
> Nothing here changes Foedrum's code or what the red proof does today ([the red proof](red-proof.md)).
> The ADR that follows the spike decides; this page gives it numbers.

## The question

The maintainer's direction of 2026-10-30 ([#618](https://github.com/EdwinBekaert/foedrum/issues/618), last comment) is to stop finding a step's tests by name and by reading source.
Line-level coverage of the change, read from LCOV or Cobertura, should answer four goals instead, on a base taken as green with no baseline run:

1. **Tests first:** the tests fail before the code exists.
2. **Tests not weakened:** the green step does not rewrite the red step's tests (`testsUnchanged`).
3. **Only the tests that matter:** a change runs the tests that reach it, not all of them.
4. **Nothing uncovered slips in:** no changed line runs under no test, and a Refactor over behaviour no test covers first adds a test that pins it.

This spike tests that on real reports from Node's built-in coverage (TypeScript) and from coverlet (C#).

### What name reading costs today

The red proof finds the step's tests by matching each reported name against the lines the step added (`judgeRed` and `declares` in `src/checks/red-proof.ts`).
It does this through the forms of ADR 0176, the `EXPRESSION_END` list of ADR 0178 and 0182, and `DECLARATIONS` in `src/checks/tests-unchanged.ts`.
The maintainer's first live brew (Brewery batch 12-2, #660, #661) showed what that costs:
- A regenerated `schemas/event.json` added `"type": "array",`. The quoted `array` read as a declaration of two older tests named `array`, so the red proof refused the step for nine passing tests ([ADR 0262](../../adr/0262-a-string-literal-declares-a-test-only-in-a-file-that-declares-a-test-at-the-step-s-tip.md)).
- The Gauger sent back to name its tests had nothing to commit and was blocked as a divergence ([ADR 0258](../../adr/0258-a-gauger-its-red-proof-sent-back-may-name-its-tests-without-a-commit.md)).

Two ADRs in one day went to keep the name reading working: a git read at the step's tip (`readTestFiles`, `src/checks/step-commits.ts`) and a new out-doc rule.
ADR 0262 itself records that the declaration list "stays incomplete for some languages and loose for others".

## The setup

Two sample repositories, built on 2026-10-30 under `.foedrum/tmp/618-spike/` (outside the tree), each with commits that act out a brew.
Every run was on Windows 11 only: path separators, coverlet's second `<source>` and case in path matching are unchecked on macOS and Linux.

| Step | TypeScript (`ts/`) | C# (`cs/`) |
|---|---|---|
| base | `src/calc.ts` (`add`, `clamp`), `src/legacy.ts` (no test imports it), `test/calc.test.ts`, 4 tests | `Calc` (`Calculator`, `Legacy` that no test calls), `Text` (`Label`, which calls `Calc`), `Calc.Tests` (4 tests), `Text.Tests` (1 test) |
| red | `multiply` stub that throws `not implemented`, two `multiply` tests, a row `[0.1, 0.2, 0.3]` added to the existing `add` table, and `clamps above`, a regression test that passes | the same: `Multiply` stub with `NotImplementedException`, an `[InlineData(int.MaxValue, 1, int.MaxValue)]` row, and `ClampsAbove` |
| red variants | a test file that imports a missing module, plus a `test.skip` | one with `[Fact(Skip = …)]`, one with a test of a method with no stub (a compile error) |
| green | the code, plus a guard (`throw new RangeError`) that no test runs | the code, plus a guard (`throw new OverflowException`) that no test runs |
| Refactor | a pure refactor of `add`; the guard changed to `return Number.NaN` (a behaviour change on an uncovered line); `percent` in `legacy.ts` changed for `whole === 0` (#645's case) | the same in `Add`, `Multiply` and `Legacy.Percent`, plus a pure refactor of `Label.Score` that only `Text.Tests` reaches |
| test-only | `multiplies` weakened from `assert.equal(…, 12)` to `assert.ok(… > 0)` | `Multiplies` weakened the same way |

Tools: Node 24.20.0 (`node --test --experimental-test-coverage --test-reporter=lcov`), .NET SDK 10.0.402 with the `dotnet new xunit` template's packages: xunit 2.9.3, xunit.runner.visualstudio 3.1.4, Microsoft.NET.Test.Sdk 17.14.1 and coverlet.collector 6.0.4 (`dotnet test --collect "XPlat Code Coverage"`, Cobertura), each test project run on its own.
The reports and diffs are in [`test/fixtures/coverage-spike/`](../../../test/fixtures/coverage-spike/README.md).
Every answer below comes from those reports, the diffs and the test results, with no source reading and no globs.

## The answers

### Code or test

**Node** reports only files that a test loaded, and by default leaves out the test files.
At every step the LCOV holds `src/calc.ts` and nothing else: neither `test/calc.test.ts` nor `src/legacy.ts`, which no test imports.
`--test-coverage-include='src/**'` does not add `legacy.ts`, because Node has no "all files" mode.
Node tells test files apart with its default `--test-coverage-exclude` globs, so for Node "coverage tells code from test" is a path rule that Node applies.
With the exclusion turned off (`--test-coverage-exclude=nothing`), the test files show up as files like any other (`lcov.with-tests.info`).
Node's JUnit reporter gives each test's `file`, passing tests included, so the test report can name the test files (TAP gives no location for a passing test).

**coverlet** instruments the assemblies that a test project references, and leaves out the test assembly and the test framework.
Every source file of an instrumented assembly appears, even when no test runs it: `Legacy.cs` is there with every line at 0 hits.
A project that no test project references does not appear at all.
Test files never appear unless `IncludeTestAssembly=true` is set.
Then they appear with their own lines, together with the SDK's `AutoGeneratedProgram` from the NuGet cache.
Each report has one `<source>`, the common root of its files, and `filename` is relative to it.
A report that also includes the test assembly has a second source (`C:\`), so a reader would match a diff path by the end of `<source> + filename`.

**So:** a changed file falls into one of three kinds:
- **code:** in the report;
- **test:** the test report names it (Node's JUnit `file`), or it belongs to the test assembly;
- **not measured:** in neither, such as Node's `legacy.ts`, data, docs, or code that no test project references.

Coverage alone gives only two kinds, "in" and "absent", and the absent kind mixes the tests with code that nothing ran.

### Which tests reach a change

Both tools give coverage **per run**, not per test.

| Per … | Node | coverlet |
|---|---|---|
| test | one run per test (`--test-name-pattern`, the name taken from the report). Declaration lines and blank lines run at module load, so they count as hit for every test | one run per test (`--filter FullyQualifiedName=…`), 11.0–11.8 s each here |
| test file | one run per file | no |
| test project | not applicable | yes, one report per test project |

For C#, per-project coverage against the project reference graph (`dotnet list reference`: `Calc.Tests → Calc`, `Text.Tests → Text → Calc`) at the Refactor step:

| Changed lines | reference graph says | coverage says |
|---|---|---|
| `Calculator.cs` `Add` (7–8) | Calc.Tests, Text.Tests | Calc.Tests |
| `Calculator.cs` `Multiply`'s guard (22) | Calc.Tests, Text.Tests | none |
| `Legacy.cs` (8–9) | Calc.Tests, Text.Tests | none |
| `Label.cs` (7) | Text.Tests | Text.Tests |

The graph picks too many projects, but safely, and it is known before anything runs.
Coverage is exact, but only as of a run that already happened, and a line the step adds is in no earlier run's map.
So selection by coverage needs a map from an earlier run, such as the red step's full run or the base's CI, and selects by file or by method.
Selection by the graph needs no run at all.
A per-project report also shows that goal 4 has to read the **union** of the reports: at the red step, the stub's lines are hit in `Calc.Tests` and at 0 in `Text.Tests`.

### Uncovered changed lines

The diff's added lines, mapped to the hits in the union of the step's reports (the reader sketched below):

| Step | TypeScript: uncovered added lines | C#: uncovered added lines |
|---|---|---|
| red | none (the stub's 4 lines run) | none (the stub's lines 18–19 run in Calc.Tests) |
| green | `13: throw new RangeError(…)`, `14: }`. **The guard is found.** | `20: {`, `21: throw new OverflowException(…)`. **The guard is found.** |
| Refactor | `14: return Number.NaN;`. **The behaviour change is found.** `src/legacy.ts` is **not in the report**, so its change is not measured | `22: return 0;`, `Legacy.cs 8–9`. **Both behaviour changes are found** (the guard and `Legacy.Percent`). |
| test-only | no code changed | no code changed |

What holds:
- A green line that no test runs is found in both languages.
- A Refactor's behaviour change on a line that no test runs is found in both languages (#645's case).
- In C#, a change in a file that no test touches is found too, because coverlet lists every file of an instrumented assembly.

What does not hold:
- Node leaves an unloaded file out of the report, so a change there (`legacy.ts`) is only "not measured". It is not "uncovered".
- A line counts as hit when any part of it runs.
  Line 7 of base `calc.ts`, `if (value > high) return high;`, has 2 hits while `return high` never runs.
  Only the branch data shows it (LCOV `BRDA:7,4,0,0`, coverlet `condition-coverage="50% (1/2)"`).
  So a change after a condition on the same line hides at line level.
- Node counts every line, braces and blank lines included.
  coverlet counts only sequence points, though `{` is one of them.

### The red step on a green base

A name-free rule: the red proof passes when the run has no load error, at least one test fails, and the step changed a file that coverage calls code.

| Case | `judgeRed` today | name-free rule |
|---|---|---|
| red (both samples): 3 tests fail, the rest pass (TS 5 of 8, C# 5 of 8 plus Text.Tests' 1) | proven, only if the Gauger names `clamps above` in `regressionTests` (ADR 0170); otherwise refused because it passes | proven; the regression test is just a passing test and needs no name |
| a row added to an existing table (`[0.1, 0.2, 0.3]`, `InlineData(int.MaxValue, …)`) | counted since ADR 0262's git read at the tip | counted, since it fails; no reading |
| load error, TS: the test file imports a missing module | refused: the TAP diagnostic holds `ERR_MODULE_NOT_FOUND` | the same text is needed. Coverage says nothing. Node's JUnit loses the text and only shows a failing "test" named after the file (`test\power.test.ts`, `testCodeFailure`) |
| compile error, C#: `error CS0117` | refused when the build output is read | `Text.Tests` writes no TRX and no Cobertura. A test project with no report is the sign |
| a skipped test | refused: the step's test is skipped | a skip shows, but whose it is does not (a green base may have skips). With test files in coverage, the skipped C# test's body line has 0 hits (`Calc.Tests.with-tests.cobertura.xml`, line 26), so it is attributable. Node's one-line `test.skip(…)` line has 1 hit, so it is not attributable at line level (only through `FNDA` of its function) |
| a stub that returns a value, so one new test passes | refused | not seen while another test fails. Reasoned from the rule; not run |
| all tests fail with `FileLoadException … blocked by an application control policy (0x800711C7)` | seen once, on base `Calc.Tests`: every test failed because Windows blocked coverlet's rewritten `Calc.dll`. `FileLoadException` was not in `LOAD_ERRORS`, so it read as **proven** when the spike ran; it is refused since [ADR 0269](../../adr/0269-the-red-proof-refuses-net-s-assembly-and-type-load-failures.md) | also proven, wrongly. Both need the load error |

The name-free rule gives what `judgeRed` gives for the usual case, the table row and the regression test, without reading anything.
It loses two things: who skipped a test, and a stub that lets one new test pass.
Either design still needs the load-error text, or a test project with no report, to refuse these cases.

**testsUnchanged without names.**
The test-only step changes a file that the red step added lines to, and that coverage leaves out (TS) or puts under the test assembly (C#).
"The lines the red step added to a test file are still there" catches the weakened assertion in both languages.
That rule is coarser than today's `DECLARATIONS`/`ASSERTIONS` filter: an edited import line in a test file trips it as well.

### Cost

Wall time in ms, three runs each. The machine was busy: 8 Claude sessions and 32 node processes.

| Run | off | on |
|---|---|---|
| TS sample, 8 tests | 579, 466, 478 | 656, 427, 427 (noise is larger than the difference) |
| Foedrum, 6 unit files around the red proof, 138 tests | 1636, 1800, 1591 (mean 1676) | 1837, 2130, 1964 (mean 1977): **+18%**; LCOV 72 files, 16,046 lines, 183 KB |
| C# `Calc.Tests`, `--no-build`, 8 tests | 13476, 8793, 7627 | 13617 (exit 1), 11477, 12738: median **+45%** |
| C# `Text.Tests`, `--no-build`, 1 test | 7495, 7216, 5958 | 29291, 11422, 12497: median **+73%** |

coverlet's cost is about 3–5 s per test project.
It instruments assemblies and does not grow with the number of tests.
Of about 36 instrumented .NET runs, one failed on the application-control block above and one more exited 1 without a captured reason; 6 reruns were clean.

## A reader, sketched

A throwaway sketch, not wired in. It returns `file → line → hits` from the formats as captured:

```js
// LCOV: SF starts a file, DA:<line>,<hits>, end_of_record ends it.
function readLcov(text) {
  const files = new Map();
  let lines;
  for (const line of text.split('\n').map((l) => l.replace(/\r$/, ''))) {
    if (line.startsWith('SF:')) files.set(line.slice(3).replaceAll('\\', '/'), (lines = new Map()));
    else if (line.startsWith('DA:') && lines) {
      const [n, hits] = line.slice(3).split(',').map(Number);
      lines.set(n, Math.max(lines.get(n) ?? 0, hits));
    } else if (line === 'end_of_record') lines = undefined;
  }
  return files;
}

// Cobertura: <class filename> under <sources>, its own <lines><line number hits>; a file in several
// classes (partial, nested, compiler-made) takes the most hits per line.
function readCobertura(text) {
  const source = /<source>([^<]*)<\/source>/.exec(text)?.[1].replaceAll('\\', '/') ?? '';
  const files = new Map();
  for (const [, attrs, body] of text.matchAll(/<class\b([^>]*)>([\s\S]*?)<\/class>/g)) {
    const name = /\bfilename="([^"]*)"/.exec(attrs)?.[1].replaceAll('\\', '/');
    if (name === undefined) continue;
    const lines = files.get(source + name) ?? new Map();
    files.set(source + name, lines);
    for (const [, n, hits] of body.slice(body.lastIndexOf('<lines>')).matchAll(/<line\s+number="(\d+)"\s+hits="(\d+)"/g))
      lines.set(Number(n), Math.max(lines.get(Number(n)) ?? 0, Number(hits)));
  }
  return files;
}
```

A real reader in `src/formats/` would sit beside `junit.ts` (165 lines with its own XML reader) and `tap.ts` (95).
LCOV is about 50 lines with its limits and errors.
Cobertura is about 60 more if it reuses `junit.ts`'s XML reader instead of regexes; that reader would move to a module of its own.
Each one would return a `CoverageReport` shaped like `TestReport` (`src/formats/test-report.ts`): `readable` or a `reason`.
No package is needed (ADR 0004).

In `foedrum.jsonc`, a setting could sit beside `testReport` (`src/schemas/brewery-config.ts`):

```jsonc
"testReport": { "format": "junit", "path": "test-results.xml" },
"coverageReport": { "format": "lcov", "path": "coverage/lcov.info" }
// or { "format": "cobertura", "path": "TestResults" }
```

coverlet's collector writes each report under a new GUID folder per test project.
Without the `coverlet.msbuild` package it cannot name the file.
So a Cobertura `path` would have to be a folder, whose `coverage.cobertura.xml` files a reader would merge by the most hits per line.
Like the test report's file, the folder would be removed before the run.

## What holds and what doesn't

| Goal | Holds? | How |
|---|---|---|
| 1. tests first | **mostly** | Failing tests on a green base plus a changed code file. A load error still needs the run's text or a missing report. A skip and a stub that returns a value are no longer attributed |
| 2. tests not weakened | **yes, coarser** | Keep every line the red step added to its test files. Test files are known from the test report (Node JUnit `file`) or the test assembly, not from coverage alone |
| 3. only the tests that matter | **C#: by the reference graph; coverage only refines** | Coverage needs a prior run. Node has neither a graph nor per-file coverage without one run per file |
| 4. nothing uncovered slips in | **yes, at line level** | Found in both languages for the green guard and for #645's Refactor. Node misses files that no test loads, and line level misses a change after a condition on the same line |

## What the ADR should decide

- **Test files.** Which source decides that a file is a test file: the test report's `file` (JUnit, where the runner writes it), the test assembly, or a declared list. And what a JUnit without `file` (most runners), TAP or TRX means.
- **Not-measured files.** What a changed file that is in no coverage report and is not a test file means: Node's unloaded `legacy.ts` and a JSON file look the same. They could fail the step, or be listed for the lenses.
- **Lines or branches.** Whether "uncovered" reads only line hits, or also `BRDA` and `condition-coverage`, to catch a change after a condition on the same line.
- **Test selection (goal 3).** Whether it is a separate mechanism (the .NET project graph, run before anything) with coverage as a check after the run, or a map from an earlier run.
- **What the red proof gives up:** attributing a skipped test and catching a stub that returns a value, unless test files are included in coverage (C#), or a skip anywhere fails the proof.
- **Load errors.** Whether `LOAD_ERRORS` stays in either design, and whether a test project with no report counts as one. `FileLoadException` (seen once here), and `Could not load file or assembly` as a `FileNotFoundException`'s message, joined it in [ADR 0269](../../adr/0269-the-red-proof-refuses-net-s-assembly-and-type-load-failures.md), each matched as an exception's text.
- **testsUnchanged.** Keep every line the red step added to a test file, or keep today's declaration and assertion filter on those lines.
- **Configuration.** Whether a `coverageReport` sits beside `testReport`, LCOV by file and Cobertura by folder, and whether a test-first recipe without one is Stuck (`environment`), as `needsTestReport` makes it today without a test report.
- **Other platforms.** Whether separators, coverlet's second `<source>` and case in path matching behave on macOS and Linux as on Windows.
- **Cost.** +18% on a Node run and 3–5 s per .NET test project, measured on a busy machine.
- **Languages with weak coverage tools** (ColdFusion, #618): what a test-first recipe does there.
