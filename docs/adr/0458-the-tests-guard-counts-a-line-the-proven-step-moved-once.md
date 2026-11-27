# 0458. The tests guard counts a line the proven step moved once

Date: 2026-11-27 · Status: Accepted · Amends [0274](0274-the-red-proof-reads-line-coverage-of-the-change-and-a-test-map-not-test-names.md) (how many copies of a red line the tip must hold)

## Context
The guard `testsUnchanged` keeps the lines the proven step added to a separate test file. It asked the tip for as many copies of each as the file held where the step started plus the copies the step added. A copy the step itself removed was not taken off.
On 2026-11-27 the Foedrum Brewery's batch 37 (#1204) stopped on it. The Gauger moved `applied(mergeKey, { base: merged, merged: 'f'.repeat(40) }),` within `test/unit/pull-request-actions.test.ts`: it removed the line at one place and wrote it at another. The guard asked for two copies where the Gauger left one, and failed a Cellarman whose commit touched only `src/checks/check-runner.ts`. The Finer runs the same guard (#1216).

## Decision
- The tip must hold each red line as often as the proven step left it: the copies where it started, plus those it added, less those its own diff removed from that file (`changedTestLines`, `src/checks/tests-unchanged.ts`).
- A later step that removes a moved line is still refused, as one that removes any red line.

## Consequences
- A Gauger that moves or rewrites a line of an older test no longer stops every writer after it.
- A file the step renamed is counted by its new path only, so its removed lines are not taken off: the guard keeps more, never less.
- **Migration:** none.

## Alternatives considered
- **Read the file at the step's tip and count there:** the same answer for one more read of the clone per file; the diff already holds what the step removed.
