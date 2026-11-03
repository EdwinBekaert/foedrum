# 0307. A failed check step's reason and the merged-tree check name the failing tests

Date: 2026-11-03 · Status: Accepted · Amends [0069](0069-check-steps-run-the-repositorys-commands-in-an-attempt-of-their-own.md) (a failed check's reason names its failing tests, its command cut when it does), [0304](0304-a-failed-test-reading-names-its-failing-tests-from-the-test-map-s-reports.md) (the reason names the tests, and the merged-tree check reads a map), [0261](0261-the-status-path-says-why-a-failed-attempt-failed-and-what-answered-a-question.md) (the path gives a failed check step's failing count), [0128](0128-an-attempt-a-route-schedules-gets-what-sent-it-back.md) (the route input's first line, the routing attempt's reason, names the tests too) and [0203](0203-an-open-pull-request-s-checks-run-on-its-merged-tree-when-its-base-moves.md) (the merged-tree check reads the test maps at its commits)

## Context
Since [ADR 0304](0304-a-failed-test-reading-names-its-failing-tests-from-the-test-map-s-reports.md) a failed test reading names its failing tests, and the merge brief, the base check's line and the route input after a failed check step show them.
Two places still said only the exit code (#790).
A check step's reason was settled (`settleReadings`) before the reports were read, so the status comment's Path and Stuck lines said `the check "test" (npm test) failed with exit code 1`.
A check on an open pull request's merged tree ([ADR 0203](0203-an-open-pull-request-s-checks-run-on-its-merged-tree-when-its-base-moves.md)) read no map, so a command that writes its reports to files sent the fix step ([ADR 0226](0226-a-failing-check-on-the-merged-tree-sends-its-batch-back-to-the-fix-step.md)) an empty tail and nothing else.

## Decision
- **The reason names the tests after `: `**: `the check "test" (npm test) failed with exit code 1: 5 tests failing: a, b, c, …`.
  A check step settles its readings again once its test reading names its failing tests, so `settleReadings` stays the one place that words a reason, and no report is read twice.
  The count comes first, then at most 3 names within 300 characters, the first always kept, then `, …` while any is left out: ten names of up to 200 characters would make a reason of 2,000.
  With names the command is cut to 80 characters (`shortCommand`, shared with the lines of ADR 0304), so a long one never pushes the count past the Stuck line's cut at 200; without names the reason reads as [ADR 0069](0069-check-steps-run-the-repositorys-commands-in-an-attempt-of-their-own.md) says, its command whole.
- **The path gives the count, not the names**: `` `green #1` ❌ the check "test" failed, 5 tests failing ``.
  The path keeps a failed attempt's first clause within 48 characters ([ADR 0261](0261-the-status-path-says-why-a-failed-attempt-failed-and-what-answered-a-question.md), #656), where names never fit.
  The count is read from the attempt's readings, never parsed from the reason, and only when they settle to the attempt's reason itself: an attempt that failed for another reason after its checks, such as a survey's disagreement ([ADR 0298](0298-the-maltster-s-survey-ends-without-a-session-for-a-fresh-map-and-its-check-sends-a-disagreement-back-once.md)), keeps that reason's clause.
  Without names the path reads as before; a long check is cut at a word as before.
  The Stuck line and the failed-attempt line show the reason, names included, within their cut at 200 characters, the count always kept.
  So does the first line of the route input a failed check step sends back (`Step green ended: …`, [ADR 0128](0128-an-attempt-a-route-schedules-gets-what-sent-it-back.md)), before the reading's own `Failing tests:` line: the names come twice there, the reason's few and the reading's ten, rather than one surface wording the reason apart.
- **The merged-tree check reads the test map at its commits**: `checkTree` takes the merged tree's head and the base's tip beside the tree, and reads the base's map at the tip and the batch's at the head (`testMap.at`, which reads a map kept in the Brewery too), as a check step reads its effective map.
  It reads the reports only when the test check failed, through the same naming as a check step's.
  The merged tree's worktree is new for each run, so its reports are that run's with nothing cleared.
  With no map, or a map or a report that cannot be read, it names none and the check ends as before: it only tells the fix step, and never waits on the map.
  Its reading carries the names to the base check's line (`readingText`) and to the route input (`failedReading`) as ADR 0304 has them; the base check posts again only when another check fails (`checkOf`), never for names alone.

## Consequences
- A person reads how many tests failed on the path, and which on the Stuck and failed-attempt lines, before the pull request is ready.
- A Cellarman sent back by a failing merged tree reads the failing tests' names.
- A failed merged-tree check reads two maps and its reports once more than before.
- A check step's reason with names no longer quotes a command longer than 80 characters whole.

## Alternatives considered
- **The names before the first `: `.** The path would cut them to `…exit code 1, 5…` at 48 characters.
- **Raise the path's 48 characters for a check.** The path is one line per round of every attempt; a few names would still not fit.
- **Drop the command from the reason when the check has a name.** A larger break with ADR 0069 and ADR 0140, for no line that needs it.
- **Widen `TreeIn` with a commit for every caller.** A check step reads its maps in its own way, before its run, and would carry a field it never reads.
