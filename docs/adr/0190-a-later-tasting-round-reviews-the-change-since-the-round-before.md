# 0190. A later tasting round reviews the change since the round before

Date: 2026-10-25 · Status: Accepted · Amends [0161](0161-lens-steps-run-a-taster-whose-findings-are-advisory-unless-the-step-blocks.md) (what a lens step's later round is given and reviews)

## Context
A tasting round exists on a lens step with `"blocking": true` and an `onBlocked` route (ADR 0161, ADR 0064): a `changes` verdict blocks the step by findings, the route sends the batch back (to `implement` in a test-first recipe), and the lens step runs again as a fresh Taster attempt. That attempt's `change` input is the whole batch's change, from where the batch's change starts to HEAD (ADR 0161, ADR 0164), as in the first round. The Taster cannot tell what changed since it last looked, so each round reviews everything again and can find new things in code that was there before the first round. Reviewers that re-read the whole change on every pass are what makes a review loop run on (#261).

## Decision
- **A later round gets the change since the round before.** A lens step's attempt that runs after an earlier round of the same step sent its batch back by a findings route (not a retry of the same round) gets a second input beside `change`: the change from the commit the latest earlier round reviewed to HEAD, read as `change` is (`git log` and `git diff` in the repository's clone, the same git options, the same size limit).
- **The commit a round reviewed** is the one its attempt's worktree started at, read from what the events already record. When it cannot be found, the round gets no second input and its prompt says so; a guessed range is never given.
- **The lenses' fixed text says how to use it**, for every `diff/` lens alike, not in one lens's file: when the input is there, review only the change since the round before, name a defect that a fix brought in as such, and leave alone what the earlier round already reviewed.
- **The first round and a retry of any round are unchanged**: a retry reviews what the round it retries would have reviewed.

## Consequences
- A second round reviews the fix, not the whole change again, so it costs fewer tokens and finds fewer new things in old code.
- The whole `change` stays an input, so a Taster can still read a fix in its context.
- A defect in code the first round passed over is not looked for again; the first round is the one that reviews the whole change.

## Alternatives considered
- **Only the change since the round before, without the whole change:** rejected. A fix is read in the code around it, and the size limit already bounds the input.
- **Ask the Taster to work out what changed from the commit log:** rejected. The engine knows the range; a model reading `git log` would guess it.
