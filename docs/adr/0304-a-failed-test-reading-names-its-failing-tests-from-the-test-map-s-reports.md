# 0304. A failed test reading names its failing tests from the test map's reports

Date: 2026-11-02 · Status: Accepted · Amends [0069](0069-check-steps-run-the-repositorys-commands-in-an-attempt-of-their-own.md) (a reading's new field), [0128](0128-an-attempt-a-route-schedules-gets-what-sent-it-back.md) (a failed check in the route input names its failing tests, and says when it printed nothing) and [0203](0203-an-open-pull-request-s-checks-run-on-its-merged-tree-when-its-base-moves.md) (the merged-tree line names the check without its command, then the failing tests)

## Context
A gravity reading ([ADR 0069](0069-check-steps-run-the-repositorys-commands-in-an-attempt-of-their-own.md)) keeps the end of a check's output, and the lines that quote it say which check failed and how.
A test command that writes its reports to files, as a test map asks ([ADR 0274](0274-the-red-proof-reads-line-coverage-of-the-change-and-a-test-map-not-test-names.md)), prints nothing.
On M2's first real exit run (2026-11-02, batches 15-1 and 16-1) both red readings were `"exitCode":1,"tail":""`, and the merge brief's red line, `the check "test" (<a long command>) failed with …`, was cut at 200 characters before it said how the check ended (#779).
Which test failed could only be read in the Gauger's transcript, though the red proof had read the names in the reports.

## Decision
- **The field.** An `exited` reading whose exit code is not 0 may carry `failing: { tests, more }`: the names of the failing leaf tests its reports name, at most 10, and the count of the rest.
  Each name is on one line (runs of white space as one space), cut to 200 characters, never inside a surrogate pair, and left out as `[left out: a name that looks like a secret]` when `findSecrets` finds one; a blank name is dropped.
  The field is optional, so a store from before it reads as it did.
- **Where it is filled**: where the reports are read already, never by a second run.
  The red proof names them from the reports it read through the map ([ADR 0297](0297-the-red-proof-reads-a-test-map-only-and-a-test-first-batch-with-none-is-stuck-before-its-first-step.md)), on a proof that passes and on one that does not.
  A check step whose test check failed reads the effective map's reports, which it cleared before its run; a TRX report stays unread (#727), and a map or a report that cannot be read names none.
  A check on an open pull request's merged tree has no map and names none.
- **How each surface shows it.** The line in the merge brief ([ADR 0225](0225-a-ready-pull-request-gets-a-merge-brief.md)), the status comment and the base check names a named check by its name alone, a literal command or the setup cut to 80 characters, then how it ended and the count before the names: `the check "test" failed with exit code 1, 5 tests failing: a, b, …`.
  The count comes first so the cut at 200 characters (`plain`) never drops it; `plain` escapes the names as any brewer's text.
  A check step's reason (`checkOf`) still names the command, as ADR 0069 says.
- **The route input** ([ADR 0128](0128-an-attempt-a-route-schedules-gets-what-sent-it-back.md)) says `Failing tests: a, b (and 1 more).` after how the check ended, and `It printed nothing` instead of an empty end of output.
  Its names are not escaped: GitHub never renders it, it reaches the brewer inside the untrusted-input tags as the tail does, one line per name, and escapes would stop the brewer matching a name to its test.

## Consequences
- A person reads which test failed red, or failed green, in the merge brief and the status comment; a Cellarman sent back reads it in its route input.
- The status comment's merged-tree line no longer shows a named check's command.
- A check step whose test check fails reads its reports once more than before.

## Alternatives considered
- **Names after the exit code, with `(and n more)` last.** Ten names of up to 200 characters reach a 200-character line, so the count would be the first thing cut.
- **Read the names again from the tail.** A command that writes its reports to files prints none there.
- **Escape the route input's names with `plain`.** Its backslashes would make the names differ from the tests the brewer reads, for no renderer.
