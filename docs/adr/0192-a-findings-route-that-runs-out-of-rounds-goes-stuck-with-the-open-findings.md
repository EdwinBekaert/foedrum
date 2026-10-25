# 0192. A findings route that runs out of rounds goes Stuck with the open findings

Date: 2026-10-25 · Status: Accepted · Amends [0025](0025-batch-lifecycle-stuck-reminders-and-rewind.md) (what a Stuck reason holds and shows) and [0161](0161-lens-steps-run-a-taster-whose-findings-are-advisory-unless-the-step-blocks.md) (the end of a blocking lens step's rounds)

## Context
When a blocking lens step's findings route has used its `maxRounds`, `decide` makes the batch Stuck as `blocked` by `findings`, with the Taster's one-line summary (`recipe.loopBack`). The status comment and `foedrum stuck` show that summary and the usual options: retry, skip, rewind, cancel. They do not list which findings are still open, and nothing says that a change which keeps failing its review may need planning again or splitting rather than another try (#261). The maintainer chose (2026-10-25) that the batch stays Stuck, as today, rather than opening a draft pull request: a lens that blocks keeps the change from leaving until someone decides.

## Decision
- **The Stuck reason says the rounds ran out.** A batch Stuck because a findings route used its rounds records the step, the rounds used, and the open findings of the last round: each one's severity, place and `why`, cut as the status comment cuts findings, bounded in count. A finding is open when no disposition settles it (ADR 0191).
- **The status comment's Stuck section and `foedrum stuck` list the open findings**, ten at most and a count of the rest, through the same filters as findings today: one escaped line each, secrets left out (ADR 0088).
- **Both recommend stepping back**, beside the options that exist: plan the order again or split it. In words until the analyse recipe (#388) can do it.
- **Nothing else changes.** A findings blocker on a step with no route, and every other Stuck reason, read as today. The new fields are optional (`npm run schemas`); an older Foedrum cannot read an event that has them, as ADR 0181 records for receipts.

## Consequences
- The person a Stuck batch reaches sees what is still wrong, not only the last summary, and is told when trying again is unlikely to help.
- A blocking lens never lets a change leave on its own after its last round.

## Alternatives considered
- **Open the pull request as a draft with the open findings:** rejected by the maintainer; at its last round it would turn a blocking lens advisory.
- **More rounds by default:** rejected. The number is the recipe's `maxRounds`; a review that does not converge in a few rounds is a sign to step back.
