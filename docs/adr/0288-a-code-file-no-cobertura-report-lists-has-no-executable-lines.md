# 0288. A code file no Cobertura report lists has no executable lines

Date: 2026-10-31 · Status: Accepted · Amends [0274](0274-the-red-proof-reads-line-coverage-of-the-change-and-a-test-map-not-test-names.md) (its not-measured rule for a tool that lists the files it did not load)

## Context
[ADR 0274](0274-the-red-proof-reads-line-coverage-of-the-change-and-a-test-map-not-test-names.md) judges only the lines a report lists as executable, so that a types-only file no test could run never fails every retry.
Its not-measured rule still counts a changed code file that no report holds as every changed line at 0 hits where the module's tool lists the files it did not load, naming coverlet and JaCoCo.
That rested on the spike's reading that coverlet lists every file of an instrumented assembly ([the spike's findings](../design/checks/coverage-spike.md)).
coverlet lists every file that has a sequence point, run or not: the spike's `Legacy.cs`, which no test calls, is in its report at 0 hits.
A file with no sequence point is in no report: an interface with no code, a project file, an `appsettings.json` under the code glob.
The review of #728 found that such a file, changed in a code area, fails the check under ADR 0274, and the Cellarman can neither run it under a test nor remove a file the change needs, so every retry fails the same way until the route runs out.

## Decision
- **A changed code file that no Cobertura report lists has no executable lines.** It is listed in the status comment under the check step, as "no executable lines in any report", and the check does not fail on it, as it does not on a file Node's LCOV leaves out.
- **A file with an executable line still fails when no test runs it.** coverlet lists such a file at 0 hits whether or not a test loaded its assembly, so the uncovered-line check judges its lines as before.

## Consequences
- A change that adds an interface, a project file or a configuration file under a .NET module's code glob passes the uncovered-line check and shows in the status comment for the lenses.
- Nothing is given up for coverlet: a file it leaves out has no line a test could run. A Cobertura writer that leaves out a file with executable lines no test loaded would let that file's change through as listed, not failed; JaCoCo, the other tool ADR 0274 names, is not read by Foedrum yet.

## Alternatives considered
- **Judge an absent file only when its extension is one the module's reports list (`.cs`).** It passes a project or configuration file, but still fails an interface-only `.cs` file, which is the case ADR 0274's rule on executable lines was made for.
- **Keep ADR 0274's rule.** Every such change would end Stuck after its route ran out, with a reason no brewer can act on.
