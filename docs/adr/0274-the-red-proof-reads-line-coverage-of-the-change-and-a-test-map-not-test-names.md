# 0274. The red proof reads line coverage of the change and a test map, not test names

Date: 2026-10-31 · Status: Accepted · Supersedes [0078](0078-the-red-proof-reads-the-test-report-and-testsunchanged-compares-lines.md)'s test names and lists (which reported tests are the proven step's, the declarations and assertions `testsUnchanged` keeps, and `testReport` as the red proof's source), [0176](0176-a-test-s-name-is-declared-only-where-a-declaration-writes-it.md), [0178](0178-a-name-before-a-parenthesis-declares-a-test-only-where-no-call-can-stand.md), [0182](0182-a-call-after-a-less-than-or-a-closing-brace-declares-no-test.md) and [0262](0262-a-string-literal-declares-a-test-only-in-a-file-that-declares-a-test-at-the-step-s-tip.md) · Amends [0017](0017-test-first-recipes-and-tasting-lenses.md) (what the red proof and `testsUnchanged` check, and an uncovered changed line fails a check), [0018](0018-house-yeast-layers.md) (a target repository's `.foedrum/` also holds the test map), [0023](0023-language-independent-recipes.md) (`testReport` moves into the test map, and a batch with no map proposes one instead of stopping; the commands stay in `foedrum.jsonc`), [0201](0201-a-repository-names-its-sensitive-paths-and-a-batch-that-touches-one-says-so.md) (the test map is a sensitive path without being named), [0269](0269-the-red-proof-refuses-net-s-assembly-and-type-load-failures.md) (a module with no report counts as a load error), [0166](0166-the-finer-simplifies-a-batch-s-change-before-green.md) (what the `testsUnchanged` guard holds against the Finer), [0170](0170-the-red-proof-accepts-the-regression-tests-a-gauger-names.md) (the red proof no longer judges `regressionTests`) and [0258](0258-a-gauger-its-red-proof-sent-back-may-name-its-tests-without-a-commit.md) (a `done` that only names tests is a divergence again)

## Context
The red proof finds the tests a step added by matching each reported test's name against the lines the step added ([ADR 0078](0078-the-red-proof-reads-the-test-report-and-testsunchanged-compares-lines.md)).
Four records have since narrowed which lines count as declaring a name: [ADR 0176](0176-a-test-s-name-is-declared-only-where-a-declaration-writes-it.md) (`null`), [0178](0178-a-name-before-a-parenthesis-declares-a-test-only-where-no-call-can-stand.md) and [0182](0182-a-call-after-a-less-than-or-a-closing-brace-declares-no-test.md) (`parse(input)`), and [0262](0262-a-string-literal-declares-a-test-only-in-a-file-that-declares-a-test-at-the-step-s-tip.md) (`"type": "array"`).
Each one followed a brew or a review in which an older test was taken for the step's.
ADR 0262 records that the declaration list "stays incomplete for some languages and loose for others".
The maintainer's first live brew (Brewery batch 12-2, #660, #661) took two records in one day: ADR 0262's git read at the step's tip, and [ADR 0258](0258-a-gauger-its-red-proof-sent-back-may-name-its-tests-without-a-commit.md)'s names-only `done`.
`testsUnchanged` leans on the same kind of list (`DECLARATIONS` and `ASSERTIONS`, `src/checks/tests-unchanged.ts`).

The maintainer set four goals for the red proof on 2026-10-30 ([#618](https://github.com/EdwinBekaert/foedrum/issues/618)):
1. **Tests first:** the tests fail before the code exists.
2. **Tests not weakened:** the green step does not rewrite the red step's tests.
3. **Only the tests that matter run:** a change runs the tests that reach it.
4. **Nothing uncovered slips in:** no changed line runs under no test.
   [#645](https://github.com/EdwinBekaert/foedrum/issues/645) showed the gap: a Refactor changed behaviour that no test covered, and the tests that did cover it passed before and after.

For refactors, the rule is that a refactor does not change behaviour.
When it touches behaviour that no test covers, a test that pins today's behaviour comes first, and the refactor follows.

The coverage spike ([#680](https://github.com/EdwinBekaert/foedrum/issues/680), [the spike's findings](../design/checks/coverage-spike.md), reports in `test/fixtures/coverage-spike/`) ran Node's built-in coverage (LCOV) and coverlet (Cobertura) on two samples acting out a brew.
- The green step's untested guard was found as uncovered changed lines in both languages, and so was #645's Refactor case.
- Coverage alone does not tell tests from unmeasured code. Node leaves out the test files and every file that no test loaded. coverlet lists every file of an instrumented assembly and leaves out the test assembly.
- A line counts as hit when any part of it ran. Only branch data shows the untaken half of `if (value > high) return high;` (LCOV `BRDA`, coverlet `condition-coverage`).
- A rule that reads no names ("a test fails on a green base") handles the usual red step, a row added to an existing table, and a passing regression test. It loses who skipped a test and a stub that lets one new test pass.
- A .NET compile error writes no report for its test project. A run that loads nothing (`FileLoadException`) still writes a report, so the load-error texts are still needed ([ADR 0269](0269-the-red-proof-refuses-net-s-assembly-and-type-load-failures.md)).
- Cost on a busy machine: **+18%** wall time on a Node run, and **3–5 s per .NET test project** (coverlet instruments assemblies, so the cost does not grow with the number of tests).

The maintainer settled eleven decisions on 2026-10-31 (#618, last comment).
This record writes them down.

## Decision

### The red proof reads no test names
- **The base is green.** A pull request merges only on green CI, so any test that fails after the red step failed because of the red step. There is no baseline run, and no full suite runs before the tests are written. A base that is red anyway shows at the green step.
- **The red proof passes when**, checked in this order, the first that fails naming the reason (`the red proof of step <of> failed: <why>`):
  1. the run did not bail out;
  2. no load, compile, import or collection error appears. `LOAD_ERRORS` stays as ADR 0078 and [ADR 0269](0269-the-red-proof-refuses-net-s-assembly-and-type-load-failures.md) have it. **A module that the base's test map lists and that wrote no test report, or no coverage report where it has a coverage tool, counts as one** (the spike's .NET compile error). A module that only the batch's map lists is the unreached case below;
  3. the step changed a file in a test area of the map, or in a module whose tests are inline. This replaces the spike's rule, which asked for a changed code file. That rule refuses a step that adds only tests, such as the Microbiologist's reproducing test or a test of existing behaviour that is wrong, and it lets through a step that changes only code and breaks older tests;
  4. at least one test fails, and where the report gives a failing test's location, at least one failing test lies in a file the step changed in a test area. By file, not by line: the report places a test at its declaration, so a row added to an existing table or an assertion edited in an existing test fails at a line the base already had;
  5. no skip the report places inside lines the step added. By line: a step's skip sits on its own line, a declaration it adds or edits, and a skip that was on the base, such as a platform-conditional one in a file the step added a test to, is not the step's.

  Checks 4 and 5 read a test's location from the runner's report (node's TAP gives one for a failing or skipped test, and many JUnit writers a `file` and `line`), never from the source, so they keep "no source reading".
- **What it gives up.** A stub that returns a value, so that one new test passes while another fails, is not seen. Where the report gives no location, neither is a skip the step added, nor a run whose only failures are older tests the step's helper edit broke, or a flaky one. All of these go to the test-design lens ([`defaults/lenses/diff/test-design.md`](../../defaults/lenses/diff/test-design.md)), which sees the red diff.
- **Regression tests need no name.** A passing test is just a passing test. The red proof no longer reads `regressionTests` (ADR 0170's checks 3 and 4 go). The gauge out doc keeps the list for the test-design lens and the status comment, which show it as before.
- **ADR 0258's names-only `done` goes.** Names no longer change what the next red proof reads, so a Gauger that a failed red proof sent back and that commits nothing would meet the same failure again. Its `done` without a commit is ADR 0074's divergence once more.
- **What goes**: the name forms of ADR 0176, 0178 and 0182, ADR 0262's test files read at the tip (`readTestFiles`), ADR 0078's name matching (`judgeRed`'s `declares`), and the `#406` short forms.
- **What stays** of ADR 0078: the step's commits read in the clone from its first attempt to its latest success, the run as a check, the reports removed before the run (now every test report and coverage report path and folder the map names, so a report an earlier attempt left never stands for this run's, nor merges its hits into it), the TAP and JUnit readers, the exit code deciding nothing, and a failed red proof taking its `onFail` route.

### Line coverage of the change decides what is uncovered
- **One mechanism**: line-level coverage read from LCOV or Cobertura, the formats the usual tools write (Node's built-in coverage, Go, gcov, coverlet, JaCoCo, cargo-llvm-cov).
  The target repository brings its coverage tool as it brings its test runner.
  Foedrum reads the formats with its own code (ADR 0004): LCOV by file, and Cobertura from a folder whose `coverage.cobertura.xml` files are merged, each line taking its highest hit count across them.
  The readers sit in `src/formats/` beside `junit.ts` and `tap.ts`, and their path handling is proven by reader fixtures on CI's Windows, macOS and Linux legs, among them a backslash `SF:` path, a drive letter in either case, and a Cobertura `<source>` with a drive.
  A report's path is made relative to the worktree's root with `/` between folders, then compared with git's path in git's own case, folding case only where the worktree's file system does not tell case apart; the map's globs are matched against those `/` paths.
  A report path or folder pattern of the map is resolved by its real path and refused when it leads out of the worktree, and a report is read as ADR 0078 reads one (a regular file, at most 16 MiB), with a cap on how many files a folder pattern may match; past either, the check is blocked on its environment, naming why.
- **A changed line must be hit**, in the union of the reports of every module the run covers.
  **Where the report has branch data for that line** (LCOV `BRDA`, coverlet `condition-coverage`), every branch on it must be taken as well. A tool without branch data is read by lines alone.
- **Only the lines a report lists as executable are judged** (LCOV `DA`, Cobertura `line`), so a declaration, a type or a brace a tool leaves out never fails.
- **Not measured.** A changed file in a code area of the map that no report holds counts as uncovered, every changed line at 0 hits, only where its module's tool lists the files it did not load (coverlet, JaCoCo).
  Where the tool leaves unloaded files out (Node), the status comment lists the file as "not loaded by any test" for the lenses, and the check does not fail on it: a types-only file imported with `import type` is never loaded, and no test could run it.
  This refines decision 4 of #618, as the maintainer settled it on 2026-10-31.
  Changed data, docs and config outside every code area are listed in the status comment for the lenses as well, and never fail the check.
- **An uncovered changed line fails the check.** The check is the `test` reading of a check step in a repository with a test map (Nip's `green`). It reads the batch's change, from where that change starts to the step's tip, and a failure takes the step's `onFail` route, so Cellarman retries: it adds a test that runs the line, or removes the line.
  A Refactor over uncovered behaviour fails the same way until a pinning regression test comes first (#645).
  The reason names up to 10 lines (file and line), with a count of the rest.
- **A module with no coverage tool still brews.** The map marks it `coverage: none`. The red proof still runs, the uncovered check is skipped for that module, and the status comment says so.
  ColdFusion and other languages with weak coverage tooling are brewed this way.
- **Every test project the map lists runs.** Selecting the tests that reach a change (goal 3), by the .NET reference graph with coverage as the check after the run, gets an issue and an ADR of its own once a real multi-project target brews.
- This is not the coverage delta that [ADR 0134](0134-the-red-proof-runs-once-the-review-drops-its-coverage-delta-and-property-and-chaos-run-on-one-leg-per-pull-request.md) removed (a percentage table for Foedrum's own pull requests).

### testsUnchanged keeps every line the red step added to a test file
- In each separate test file of the map, every line the proven step added must still be there at the guarded attempt's tip, as often as before, compared trimmed. Moving a test within its file is still fine.
- This is coarser than ADR 0078's filter: an edited import line in a test file trips it too, and the brewer restores it on its retry. The `DECLARATIONS` and `ASSERTIONS` pattern lists go.
- **A skip added at green fails too.** Check 5 also runs at the green check: a skip that the green run's report places in a separate test file of the map, inside lines the batch added, fails that check, so a green step cannot keep every red line and add a `t.skip()` beside them.
  A green step that weakens a red test by other added lines, such as an early `return;` or a `try { … } catch {}` around its assertions, is the test-design lens's to find.
- Inline tests (a Rust `#[cfg(test)]` module) are not guarded mechanically. The test-design lens judges them against the red diff.
- Where the guard runs, its outcome (`failed`, retryable) and its git reads in the clone stay as ADR 0078 has them.

### The test map
- **What it is.** One file per target repository says, for each module, where its code is, where its tests live (separate paths, test projects, or inline), and the formats and paths of the test and coverage reports its tests write, or `coverage: none`. It says where things are, and holds no commands.
  The red proof's changed test area, its load error for a module with no report, `testsUnchanged` and the not-measured rule read it. Which tests fail or are skipped, where the report places them, and which lines ran come from the reports alone.
  Prior art: SonarQube's `sonar.tests`, Stryker's `mutate`, Codecov's `ignore`, and cargo-mutants skipping `#[cfg(test)]`.
- **Where it lives**: `.foedrum/test-map.jsonc` in the target repository, beside `.foedrum/house-yeast/`. Every Brewery on the repository shares it (#120), and it is versioned with the code.
  A repository whose owners refuse it uses the Brewery fallback of [ADR 0018](0018-house-yeast-layers.md): a `houseYeast`-style setting in its `foedrum.jsonc` entry keeps the map under the Brewery's files.
  Its content is repository content, untrusted input like the house-yeast rules (ADR 0018, ADR 0041).
- **The base's map governs what the base lists.** For every module and area the base's map lists, the checks read the base's map, as `/brew-review` takes its criteria from the base ([ADR 0122](0122-house-yeast-for-foedrum-s-own-reviews-candidates-in-the-main-checkout-rules-per-lens.md)).
  The batch's map may add modules and areas, but it does not narrow or remove them, nor set `coverage: none` on a module the base measured, until a person merges it. A path in both a base area and one the batch adds is read by the base's entry. So a brewer cannot switch off the checks of the base's modules by editing the map.
  A module the batch adds with `coverage: none` is named in the status comment, beside the sensitive-path line the map's change already gets.
  One exception, so that a deleted project does not read as a load error: a base module drops out only when the batch also deletes every file under its code and test areas. Otherwise its missing report stays a load error.
- **Who writes it.** An agent derives it from the repository's manifests, and a person confirms it in a reviewed change: the pull request that carries it. Which brewer and which command derive it is the build's choice.
- **Freshness is judged by change, not by age.** The map is stale when:
  - the manifest files it was derived from (its globs, which the map's schema validates, read with `git ls-files` at the step's tip, after `--` so that no glob is read as an option) differ from the matched paths it records; or
  - a run reports a test, or writes a report, outside the map.

  The brewer whose change made it stale updates it in that change, so the map ships with the fix, as a repository-layer rule does (ADR 0018).
  A map that is stale on the base is refreshed by the batch's first step, the batch brews with the refreshed map, and the pull request says why.
- **No map is the extreme case of a stale one.** The batch's first step proposes a map, the batch brews with it, and the pull request carries it for review.
  A batch is Stuck (`environment`) when the discovery step cannot produce a map that a run agrees with, or when no confirmed line reaches a module (below).
  So the map replaces `testReport` for the red proof and the uncovered check, and ADR 0078's Stuck start for a repository without a `testReport` goes with it.
- **Commands stay in `foedrum.jsonc`**, confirmed by a person, as [ADR 0023](0023-language-independent-recipes.md) has them. A module's tests run under a confirmed check line, such as one `dotnet test` over the solution that writes a report per test project. The red proof and the uncovered check read the reports of that line's run where the map says they are.
  A module that the map lists and that no confirmed line reaches, such as a new test project the confirmed line does not run, makes the batch Stuck (`environment`). The reason names the module and suggests the line to add. Foedrum never runs a command that the map or a brewer proposed.
  A module the base's map already lists is taken as reached, as the base is taken as green, so when it writes no report that counts as a load error (above). A module the batch's change added to the map, which writes no report, is the unreached case.
  So a new module that the confirmed line does reach but that fails to compile is read as unreached, and its batch is Stuck instead of retried. That is accepted: a person sees it at once, and the Stuck reason carries the tail of the run's output, the check's recorded tail, cut and read for secrets as every reading's is, so the compile error shows.
- **It is a sensitive path.** The map is in `sensitivePaths` without being named there, so the status comment names a change to it ([ADR 0201](0201-a-repository-names-its-sensitive-paths-and-a-batch-that-touches-one-says-so.md)).
  A map a batch proposed or refreshed is one such change.
- **Its shape**, a sketch for the build issue rather than a schema:

```jsonc
{
  "derivedFrom": {
    "globs": ["**/package.json", "**/*.sln", "**/*.csproj", "**/Cargo.toml"],
    "paths": ["web/package.json", "svc/Billing.sln", "svc/src/Billing/Billing.csproj",
              "svc/test/Billing.Tests/Billing.Tests.csproj", "svc/test/Billing.Api.Tests/Billing.Api.Tests.csproj",
              "engine/Cargo.toml"]
  },
  "modules": [
    {
      "name": "web",
      "code": ["web/src/**"],
      "tests": { "paths": ["web/test/**"] },
      "testReport": { "format": "junit", "path": "web/test-results.xml" },
      "coverage": { "format": "lcov", "path": "web/coverage/lcov.info" }
    },
    {
      "name": "billing",
      "code": ["svc/src/**"],
      "tests": {
        "projects": [
          { "path": "svc/test/Billing.Tests" },
          { "path": "svc/test/Billing.Api.Tests" }
        ]
      },
      "testReport": { "format": "trx", "path": "svc/test/*/TestResults" },
      "coverage": { "format": "cobertura", "path": "svc/test/*/TestResults" }
    },
    {
      "name": "engine",
      "code": ["engine/src/**"],
      "tests": { "inline": true },
      "testReport": { "format": "junit", "path": "engine/target/nextest/junit.xml" },
      "coverage": { "format": "lcov", "path": "engine/lcov.info" }
    }
  ]
}
```

  The confirmed line for `billing` might be `dotnet test svc/Billing.sln --collect "XPlat Code Coverage" --logger trx`, which writes one report per test project, each into a new folder: so a Cobertura or TRX `path` is a folder pattern.
  A report format Foedrum does not read yet (TRX here) is the build's to add or to refuse.
  A module without a coverage tool writes `"coverage": "none"`.

## Consequences
- Test names stop mattering. A string, a free function's call or a regenerated schema can no longer be taken for a test's declaration, and the name lists stop growing, language by language.
- Fewer failures to attribute: a stub that lets one new test pass while another fails, and, where the report gives no location, a skip the step added or a failure only in older tests, are the test-design lens's to find, not the engine's.
- A changed file in a Node module that no test loads, such as the spike's untested `legacy.ts`, no longer fails the check: it stays visible as "not loaded by any test" in the status comment. Where the tool lists unloaded files (coverlet, JaCoCo), the same change still fails.
- A red step whose only change is outside every test area (a Gauger that only wrote code) is refused in a module with separate test areas. In a module whose tests are inline, check 3 cannot tell code from tests, and the test-design lens judges such a step.
- Every test-first batch runs its tests with coverage on: +18% on a Node run and about 3–5 s per .NET test project, measured on a busy machine. The cost is accepted.
- A changed line after a condition on the same line is caught only where the tool writes branch data.
- `testsUnchanged` refuses an edited import or helper line in a separate test file that the red step added, which ADR 0078 let change. The retry restores it.
- Target repositories get one more committed file, `.foedrum/test-map.jsonc`, or the Brewery keeps it for them.
- A wrong map misleads both the guard and the not-measured rule. A person's confirmation, the sensitive-path line and the freshness rules are what keep it right.
- A map a batch proposed runs nothing: it only says where the confirmed line's reports and tests are. A person still confirms every command Foedrum runs (ADR 0023), and a module that no confirmed line reaches stops the batch with the line to add, rather than running one.
- The uncovered check overlaps Brett ([ADR 0017](0017-test-first-recipes-and-tasting-lenses.md)) and the test-design lens, which also look for changed code no test catches; all three stay. Brett runs a few model-chosen mutants and is advisory, and the lens judges; the check is deterministic, reads every changed line and fails the step. It is part of what a test-first recipe checks, as the red proof is, not a guard against a trust boundary, so it takes no row in [who guards what](../trust-boundaries.md).
- Until the build lands, the red proof works as [the red proof](../design/checks/red-proof.md) describes it today.
- The build splits into issues for the test map (schema, storage and fallback, freshness, sensitive path, discovery), the coverage readers, the red proof's name-free rule, the uncovered-line check, and `testsUnchanged`. The last one also gives the test-design lens's prompt the duties this record hands it: skipped tests where the report gives no location, inline tests that a later step weakened, and a red test a green step weakened by added lines (an early return, a `try`/`catch` around its assertions). Until that prompt says so, the lens does not check them. It already flags a stub that returns a value.

## Alternatives considered
- **Keep the name reading and grow its lists.** Four records in a week each closed one case, and ADR 0262 itself says the list stays incomplete and loose.
- **A baseline run before the red step** (ADR 0078's first alternative). It finds the new tests exactly, but it doubles the runs, and a base that does not build says nothing. A green base is what CI already proves.
- **Tell code from tests by coverage alone.** Node leaves out unloaded code and the tests alike, so "absent from the report" mixes the two (the spike's `legacy.ts`).
- **Tell test files by the test report's `file`.** Most JUnit writers leave it out, TRX has none, and node's TAP gives a location only for a failing or skipped test, so a passing test's file is unknown. The red proof uses a location only where a failing or skipped test has one (checks 4 and 5).
- **Lines only.** Simpler, but it misses the untaken half of a one-line condition, which the reports already carry where the tool writes branches.
- **Fail the step on a not-measured data or config file.** Every change to a fixture or a workflow would need a test that cannot exist.
- **Coverage thresholds.** A percentage cannot see one uncovered changed line.
- **Select tests by coverage from an earlier run.** A line the step adds is in no earlier run's map. Selection is a separate decision (goal 3).
- **A package to read LCOV or Cobertura.** Each format is about 50–60 lines of Foedrum's own code, and ADR 0004 allows only `zod`.
- **The map holds each module's commands, and a proposed map's commands run in the check sandbox until the pull request's review.** A new module would brew without a person adding a line first. Not taken: a person confirms every command Foedrum runs (ADR 0023), and native Windows has no check sandbox ([ADR 0076](0076-check-steps-run-in-an-os-sandbox-with-no-network.md)), so a proposed command would run there with only a Job Object around it.
- **The map in the Brewery only.** It would drift from the code it describes, and a second Brewery on the same repository would not see it (ADR 0018's reason for the repository layer).
