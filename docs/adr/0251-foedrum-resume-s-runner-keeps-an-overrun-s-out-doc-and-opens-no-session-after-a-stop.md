# 0251. foedrum resume's runner keeps an overrun's out doc, and opens no session after a stop

Date: 2026-10-28 · Status: Accepted · Amends [0175](0175-a-turn-overrun-is-retried-by-resuming-its-session-and-keeps-its-out-doc.md) (its kept out doc covers `foedrum resume`'s runner too, and its consequence that a takeover always removes the out doc goes), [0127](0127-foedrum-resume-takes-a-running-batch-over-and-continues-its-step-s-session.md) (its runner keeps or puts back the out doc of a retry after a turn overrun, and a stop before the session opens ends the attempt cancelled) and [0222](0222-a-recipe-s-brewer-step-may-be-interactive.md) (a stop before an interactive step's session opens ends the attempt cancelled and opens none)

## Context
The interactive runner opens a step's session as the person's `claude` in the foreground: an interactive step's for `foedrum brew` ([ADR 0222](0222-a-recipe-s-brewer-step-may-be-interactive.md)), and a resumed one's for `foedrum resume` ([ADR 0127](0127-foedrum-resume-takes-a-running-batch-over-and-continues-its-step-s-session.md)).
A code audit of main at `b01300bb` found two places where it parts from the headless runner (#614).

- **It always cleared the out doc before the session.** The headless runner keeps the out doc of a resumed retry after a turn overrun, or puts back its copy ([ADR 0175](0175-a-turn-overrun-is-retried-by-resuming-its-session-and-keeps-its-out-doc.md)). So when `foedrum resume` took over such a retry, the work the overrun session wrote was lost, and ADR 0175 exists to prevent that loss. ADR 0175 named the takeover as unchanged, as one that continues a run that has not ended on its budget. But resume's driver resumes every attempt of the batch it takes over (ADR 0127), so it also opens a retry after an overrun.
- **A stop reached it only in its headless branch and during a setup.** A stop that came while the attempt's plan was made, or during a setup that passed all the same, still opened claude in the person's terminal for an attempt the engine had stopped. ADR 0222 already says that nothing the session then writes is read. ADR 0127's "a stop does not end the engineer's session" is about a session that is already open.

## Decision
- **`foedrum resume`'s runner keeps the out doc after a turn overrun**, as the headless runner does. A resumed plan that names the overrun's copy (`outDocFrom`) keeps the out doc in the worktree, or puts the copy back there, and every other plan clears it ([ADR 0118](0118-retrymode-resume-loads-and-an-answer-resumes-the-session-that-asked.md)). Both runners do this through one function (`outDocBefore`) and count commits through one function (`commitsOf`).
- **A stop before the session opens ends the attempt `cancelled` and opens no session.** The runner checks for a stop once the plan has come, before it writes a file in the worktree, and again just before it opens claude, after any setup. Its ending is the one a stopped headless run reaches: `settleAttempt` reads a `stopped` exit as `cancelled`. An `unstartable` exit would have been a failure that is not retried.
- **A session that is open stays the person's**, as ADR 0127 and ADR 0222 have it: a stop does not end it, and what it writes after the stop is not read.

## Consequences
- `foedrum resume` of a retry after a turn overrun opens the session with the out doc the overrun wrote, so the person finishes that work instead of writing it again.
- An attempt stopped while it is planned or set up costs the person no session to close. It costs the step what a stopped headless attempt costs.
- The interactive runner still records no stream report, and its signals never abort the session: those differences come from the session belonging to the person (ADR 0127).

## Alternatives considered
- **End a stop before the session as `unstartable`.** That would be a failure that is not retried, for an attempt the engine itself stopped. A stopped headless run is `cancelled`.
- **Keep clearing the out doc on the interactive path.** The overrun's work would be lost exactly where a person takes over to finish it.
