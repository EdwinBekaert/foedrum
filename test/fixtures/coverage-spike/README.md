# Coverage reports of spike #618

These are captured reports for [the coverage spike](../../../docs/design/checks/coverage-spike.md). They are data only: no test reads them yet, and the sample sources are not here.

They were made on 2026-10-30, on Windows 11, from two sample repositories under `.foedrum/tmp/618-spike/`, each a git repository whose commits act out a brew.
For each step, the folder holds the coverage of the whole run at that commit and `step.diff`, which is `git show` of the commit (the base's diff adds every file).
This machine's paths are replaced with `C:\spike\` and `C:\Users\dev`.

## `ts/`: Node 24.20.0

`node --test --experimental-test-coverage --test-reporter=lcov --test-reporter-destination=lcov.info`, with Node's default coverage exclusions, which leave out the test files.

| Folder | Commit |
|---|---|
| `0-base` | `add` and `clamp` with 4 tests; `src/legacy.ts`, which no test imports |
| `1-red` | the `multiply` stub that throws, two `multiply` tests, a row in the `add` table, and `clamps above`, which passes |
| `1b-red-variant` | from `1-red`: a test file that imports a missing module, and a `test.skip`. `lcov.with-tests.info` is the same run with `--test-coverage-exclude=nothing` |
| `2-green` | `multiply` and the rounded `add`, with a guard that no test runs |
| `3-refactor` | a pure refactor of `add`, the guard changed to return `NaN`, and `percent` changed in `legacy.ts` |
| `4-test-only` | the `multiplies` assertion weakened |

## `cs/`: .NET SDK 10.0.402, coverlet.collector 6.0.4

There is one Cobertura file per test project, from `dotnet test test/<project> --collect "XPlat Code Coverage"`.
The packages are those of the `dotnet new xunit` template: xunit 2.9.3, xunit.runner.visualstudio 3.1.4, Microsoft.NET.Test.Sdk 17.14.1.
`Calc.Tests` references `Calc`; `Text.Tests` references `Text`, which references `Calc`.

| Folder | Commit |
|---|---|
| `0-base` | `Calculator` (`Add`, `Clamp`), `Legacy` (no test calls it), `Label` |
| `1-red` | the `Multiply` stub that throws, two tests, an `InlineData` row, and `ClampsAbove`, which passes |
| `1b-red-skipped` | from `1-red`: `MultipliesByZero` skipped. `Calc.Tests.with-tests.cobertura.xml` is the same run with `IncludeTestAssembly=true` |
| `1c-red-compile-error` | from `1b`: a test of `Label.Badge`, which does not exist. `Text.Tests` does not build, so it wrote no report, only `Text.Tests.build-error.txt` |
| `2-green` | `Multiply` and the saturating `Add`, with a guard that no test runs |
| `3-refactor` | refactors of `Add` and `Label.Score`, the guard changed to return `0`, and `Legacy.Percent` changed |
| `4-test-only` | the `Multiplies` assertion weakened |
