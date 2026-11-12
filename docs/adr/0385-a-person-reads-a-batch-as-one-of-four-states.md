# 0385. A person reads a batch as one of four states

Date: 2026-11-12 · Status: Accepted · Amends [0205](0205-stop-makes-an-order-s-brewing-batches-stuck-at-once-and-retry-continues-them.md) (a stop's words in `foedrum status`, `foedrum stuck` and the status comment), [0316](0316-a-brewery-issue-s-label-and-status-comment-name-the-person-s-next-action.md) (a split order's `Next:` line), [0275](0275-a-finished-plan-waits-stuck-for-its-review-and-every-comment-links-the-doc-it-sums-up.md) (the status comment's line for a plan waiting for its review), [0281](0281-foedrum-approve-signs-off-a-plan-by-its-hash-and-puts-the-batch-on-tap.md) (the plan comment's Gate while it waits, and the status comment's line of an approved plan), [0293](0293-a-split-order-ends-once-every-sub-order-merged-and-the-engine-closes-it.md) (a done order's one line, and a sub-order's row without a pull request) and the on-tap words of `foedrum status` that #905 chose

## Context
Each surface named a batch by its engine lane: `stuck`, `on tap`, `conditioning`, `ordered`, `brewing`, `cancelled`.
A lane says where the engine holds a batch, not what a person does about it.
`npm run demo -- ladder` on main showed it (#834):
- `foedrum status` printed `1-1  #1  stuck  the plan of plan #1 is ready for your review`, a review that waits for the person, under the word for a failure.
- After both pull requests merged it printed `3-1  #3  on tap  …/pull/7 merged`, so the finished order read as work waiting for a merge.
- The status comment's state block had two lines, `🍻 **On tap**: plan approved …` and `🍻 **Done**: every sub-order merged`.

The maintainer decided (2026-11-12): one small function turns a batch's engine state into one of four words a person reads, which the status comment, the plan comment, `foedrum status` and `foedrum stuck` show alike.
Labels, command names, batch ids, the lanes, events and schemas stay as they are.

## Decision
- **Four states.** `batchState` (`src/engine/batch-state.ts`) reads a batch, with its order's sub-order rows once it is split, and returns one of:
  - **Running**: Brewing, or an on-tap order with an approved plan whose sub-orders still brew.
  - **Waiting for you**, and what for: a plan's review (`approve the plan`), a question or a changed order (`answer a question`), an interactive step's session (`open its session`), a person's stop (`stopped by <who> (retry or cancel)`), every other Stuck reason (`look at a failure`), an on-tap pull request with no recorded end (`merge a pull request`), or a split order a sub-order keeps open (`see to what keeps the order open`).
  - **Queued**: Ordered, or Conditioning on a merge, a release or another batch, none of which waits on the person.
  - **Done**, and how: its pull requests all ended (each `merged` or `closed without merging`), every sub-order merged, cancelled, or on tap with no pull request, no approved plan and no sub-orders.
- **One function, each surface's own words.** The state's words and what it waits for come from `batch-state.ts`; each surface keeps its layout and writes its details after them.
  - The status comment's first line is the state in bold after the lane's mark (🔔 for Waiting for you), then what for and the Stuck reason; a done split order has one line, `🍻 **Done**: every sub-order merged`; a sub-order's row without a pull request shows its batch's state.
  - The plan comment's Gate reads `Waiting for you: approve the plan with foedrum approve <n>.` while the plan waits.
  - `foedrum status` (and its `--watch` board) shows the state in its column: `1-1  #1  waiting for you  approve the plan`, `3-1  #3  done  merged: <url>`; an on-tap batch with an open pull request names it after `merge a pull request:` and how each other one ended.
  - `foedrum stuck` starts each batch's line with `waiting for you:` and what for; its count line keeps the command's word.
- **A pause is no state.** A paused batch shows the state underneath and who paused it, since a pause may stop what runs or only hold new work.
- **What stays.** The labels ([ADR 0316](0316-a-brewery-issue-s-label-and-status-comment-name-the-person-s-next-action.md)), `foedrum brew`, `replay` and `resume` keep the lane's words; every `Next:` line stays, but for a split order's, which says each pull request `comes to you to merge` instead of `on tap`.

## Consequences
- A person reads the same word for a batch in the comment and on the terminal, and a finished order reads as done.
- The engine's lanes stay inside the engine: no event, schema or label changes, and nothing in the engine reads the state.
- `foedrum status` no longer says `open` beside a pull request: one without an end is named after `merge a pull request:`.
- **Brewery migration:** none; Foedrum has no release, and the change reads only what the fold has.
