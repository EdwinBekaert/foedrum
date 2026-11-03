# 0308. A Taster reads the checks that ran on its head, and an out doc claims only what its session did

Date: 2026-11-03 · Status: Accepted · Amends [0214](0214-a-taster-s-out-doc-says-what-risk-is-left.md) (a Taster's risk left never lists a check its `checks` input shows ran, and names a file it could not read only after it tried), [0005](0005-typed-step-outcomes-and-out-docs.md) (the out doc contract gains one rule on claims, and its budget goes from about 300 to about 350 tokens) and [0291](0291-a-release-blocked-sub-order-s-brewers-read-the-release-it-waited-for-as-written.md) (a Taster looks for the released code in its worktree before it says it could not read it)

## Context
M2's first real exit run (2026-11-02, batches 15-1 and 16-1) showed out docs that claim what their sessions never did.
Every Taster's risk left listed "I did not run npm test; the passing state is not verified", though the `green` check step had run the tests on the same commit and passed before the Tasters started, and the merge briefs repeated it under Risk left (ADR 0225).
One Taster wrote "Could not read the greet v1.2.0 source" with no tool call but the write of its out doc, while `node_modules/greet` at v1.2.0 was in its worktree.
The Finer, the Gauger and an acceptance Taster stated checks, installs and reads they never attempted.
A Taster is read-only and runs no command (ADR 0161), so it cannot know what the checks proved unless the engine tells it, and nothing in any prompt asked a brewer to keep its claims to what it did.

## Decision
- **A brewer input source `checks`**: `{ "name": "checks", "from": "checks" }`, filled by the engine (`checksInput`, `src/engine/check-readings.ts`), for each step of the batch whose latest attempt finished on the commit the asking attempt's worktree starts at, in the order the batch's steps first appear: the step's id and how each of its checks ended, passed, failed in the status comment's words (with its failing tests, ADR 0304), or not run because the repository does not have it.
  The tag's source is `the checks that ran on commit <sha>`.
- **The same commit ties a reading to the head.** A reading records no commit, but its attempt's worktree does, from its `step.started`, and a check step never commits, so the commit its worktree started at is the one it checked.
  A later round after a fix with no check since gets no input, and a check that failed on the head before the fix is never shown as the head's.
- **Setup readings are left out** (ADR 0163), as the merge brief leaves them out: they are the run's install, not the change's checks.
  `checkReadings` moves beside `checksInput`, so the brief and the input read readings in one place.
- **Left out when nothing ran on that commit**, or when the attempt has no worktree of its own (a Brewery order's checkouts, ADR 0301): the input is never made up.
- **The default Taster asks for it** (`defaults/brewers/taster.md`, version 5), so every Taster step of every recipe gets it, and its `riskLeft` item says never to list a check `{checks}` shows ran, and to name a file it could not read only after it tried.
- **The released code is looked for, not promised.** A Taster has no shell, so a repository's setup runs before its attempt only when the repository's `tools` give it one (ADR 0163); its prompt says that when the setup installed the dependencies, the released code is in its worktree (in `node_modules`, for example), and to look for it before saying it could not read it. The `release` input's own text stays as it is: the Gauger and the Cellarman read it before any bump.
- **One rule on claims in the out doc contract** (`outDocContract`), so every brewer gets it: an assumption or a risk states only what the session did or read; "I did not check X" is fine, but "X could not be checked" needs the attempt that failed.
  The contract grows from 1,179 to 1,326 characters, and its test bound from 1,200 to 1,400 (1,600 with the commit lines).
  Every default brewer's version goes up, since every rendered prompt changes.

## Consequences
- A Taster's risk left and the merge brief's Risk left no longer list a check the engine ran on the reviewed head as unverified.
- A Taster whose head had no check (a recipe with no check before its lens steps) reads as before.
- Whether the rule on claims holds is the model's: the maintainer tries the bumped prompts on the next real order.
