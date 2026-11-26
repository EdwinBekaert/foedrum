# 0430. A repository can name a second test line, whose coverage the uncovered-line check reads too

Date: 2026-11-26 · Status: Accepted · Amends [0274](0274-the-red-proof-reads-line-coverage-of-the-change-and-a-test-map-not-test-names.md) (the uncovered-line check judges a changed line against the coverage of the `test` check and of a second test line) and [0242](0242-a-repository-can-name-a-fast-local-test-and-its-pull-request-checks-are-the-full-gate.md) (a check step that runs `testChanged` also runs the second line, in full)

## Context
The uncovered-line check of a check step fails every changed line no test ran ([ADR 0274](0274-the-red-proof-reads-line-coverage-of-the-change-and-a-test-map-not-test-names.md)).
It reads the coverage of one run of the repository's `test` check, each module's report where the test map names it, and merges them.
A repository whose CI runs tests the `test` line does not, such as Foedrum's own `test/integration`, has code only those tests reach.
For a change there, every attempt of the batch fails the check with `<n> changed lines no test runs`, though the tests pass in CI: the Cellarman's retries cannot add a test the `test` line runs, since the code needs a real git repository and a real run (#1156, `compare()` in `scripts/tasting-compare/harness.ts`, 11 changed lines, failed twice).

## Decision

### Where the second line and its report are named
- `checks` in `foedrum.jsonc` takes an optional `testSecond` command beside `test`, written like the others (one line, or `{ "run", "windows", "macos", "linux" }`). It is the command, so it stays where commands are kept ([ADR 0023](0023-language-independent-recipes.md), [ADR 0274](0274-the-red-proof-reads-line-coverage-of-the-change-and-a-test-map-not-test-names.md)).
  It needs no `{base}`, and is refused with a `test` of `null`.
- A module of the test map takes an optional `coverageSecond`, `{ "format": "lcov" | "cobertura", "path": … }`, written and limited as its `coverage` is: where the second line writes that module's coverage.
  The map holds places only, so it still holds no command.
- The field is optional because the design makes it so: a repository without a second line sets neither.

### How a check step runs it
- A plain check step whose checks name `test` runs `testSecond` right after the `test` check, in full, when the repository sets it. This holds after a run of `testChanged` ([ADR 0242](0242-a-repository-can-name-a-fast-local-test-and-its-pull-request-checks-are-the-full-gate.md)) too: it runs after that line, with no `{base}`, and its reading is the `testSecond` line as a command of no check name, so a failure reads `the check "<command>" failed with exit code <n>`, and fails the step along its `onFail` route as any check does.
- The red proof, a survey's check, Brett's scratch trees and the checks of an open pull request's merged tree run `test` alone, as before: only the uncovered-line check reads the second line.
- Before the `test` check runs, every `coverageSecond` path of either map is cleared with every coverage and test report path ([ADR 0274](0274-the-red-proof-reads-line-coverage-of-the-change-and-a-test-map-not-test-names.md)), so a report an earlier run left neither stands for this run's nor adds its hits to it. One that cannot be cleared blocks the step on its environment before anything runs.

### How its coverage counts
- For a module the change touches, the uncovered-line check reads its `coverageSecond` beside its `coverage` and merges both with the other modules' reports; a changed line that either run is tested. A line neither runs still fails with the same reason.
- A second report that is missing or does not parse fails the step as the `coverage` one does, naming the module.
- A module the change does not touch has its second report left unread: only the line's own coverage of it is read, as before, and an untouched module's missing second report says nothing.
- After a run of `testChanged` only the touched modules' reports are read, as before; the second line, run in full, adds its report of each touched module.

## What an existing Brewery must change by hand
Nothing, unless it wants a second line. Then a person, in the Brewery (`foedrum.jsonc`, and `test-maps/<owner>/<name>.jsonc` when the Brewery keeps the map), adds:
- `"testSecond"` in the repository's `checks`, a command that runs the other tests and writes coverage as LCOV or Cobertura.
- `"coverageSecond"` on each module those tests reach, with the format and path of that report.

For Foedrum's own repository, `test/integration` is the second line, so in the Brewery's `foedrum.jsonc` its `checks` gets a `testSecond` that runs `test/integration/**/*.test.ts` with node's coverage, written as LCOV to `integration.lcov` (the `.gitignore` already leaves out `*.lcov`):
`node scripts/with-checkout-tmp.ts --import ./scripts/lower-priority.ts --test --experimental-test-coverage --test-reporter=spec --test-reporter-destination=stdout --test-reporter=lcov --test-reporter-destination=integration.lcov "test/integration/**/*.test.ts"`,
and its module in `test-maps/edwinbekaert/foedrum.jsonc` gets `"coverageSecond": { "format": "lcov", "path": "integration.lcov" }`. The person confirms the command in the Brewery, as for every command of `foedrum.jsonc`.

## Consequences
- A change only an integration test reaches passes the uncovered-line check once that test runs the line.
- A check step runs one more command per round in a repository that sets it, and the second line's time is part of the step's deadline.
- The second line's coverage never counts for a module the change does not touch, so a line of another module only its second line runs is judged by that module's own coverage.
- A repository's pull request checks stay the full gate: setting `testSecond` promises nothing about them.
- How a skip of the coverage check could hold for later rounds is not decided here.

## Alternatives considered
- **A command for the second line in the test map.** The map holds places and never a command ([ADR 0274](0274-the-red-proof-reads-line-coverage-of-the-change-and-a-test-map-not-test-names.md)); the Brewery's own map is a file a batch cannot change, and a command there would be one a repository's owners could set without the person who confirms `foedrum.jsonc`.
- **A list of any number of lines.** One second line settles the case; a list asks for an order, a name and a report per entry that no repository has asked for.
- **Making the `test` line run the integration tests.** The line is the repository's test gate and its CI's; a slower line costs every round of every batch, and a repository may keep the tests apart on purpose.
- **Skipping the check for a change only the second line reaches.** It lets any uncovered line through; counting the second line's coverage keeps the check's promise.
