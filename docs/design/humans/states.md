# What a person reads a batch as

A person reads one of four states for a batch, the same on every surface that shows one ([ADR 0385](../../adr/0385-a-person-reads-a-batch-as-one-of-four-states.md)).
One function works it out from the batch's lane, `batchState` in `src/engine/batch-state.ts`; the lanes stay the engine's, and the labels stay the lanes' ([on GitHub](github.md)).

| State | When | The few words after it |
|---|---|---|
| **Running** | a brewer or a check works on it, or a split order's sub-orders brew | the steps under way, or `the sub-orders brew (#2, #3)` |
| **Waiting for you** | it waits for a person | what for: `approve the plan`, `answer a question`, `open its session`, `stopped by <who> (retry or cancel)`, `look at a failure`, `merge a pull request`, or `see to what keeps the order open` |
| **Queued** | ordered and not routed yet, or conditioning on a merge, a release or another batch | what it waits for |
| **Done** | its pull requests all ended, every sub-order of its order merged, it was cancelled, or it ended on tap with no pull request | how: `merged`, `closed without merging`, `every sub-order merged`, `cancelled by <who>`, `no pull request` |

A Stuck batch waits for you: a plan's review for its approval, a question or a changed order for an answer, an interactive step for its session, a stop for a retry or a cancel, and every other reason for a look at the failure, whose reason follows.
An on-tap batch waits for you while any of its pull requests has no recorded end, and is done once all have one.
A pause changes no state: the surface shows the state underneath and who paused it ([pause](pause.md)).

## Where it shows

- **The status comment**: its first line, the state in bold after its mark (🍺 Running, 🔔 Waiting for you, 📥 or ⏳ Queued, 🍻 Done, 🚫 Done when cancelled), then its few words; a done split order's one line is `🍻 **Done**: every sub-order merged`.
  A sub-order with no pull request yet shows its own batch's state in its row.
- **The plan comment**: its Gate, `Waiting for you: approve the plan with foedrum approve <n>.`, while the plan waits for its review; an approved plan's Gate names who approved it.
- **`foedrum status`** and its `--watch` board: the state column, then the few words, for example `1-1  #1  waiting for you  approve the plan` and `3-1  #3  done  merged: <url>`.
- **`foedrum stuck`**: each Stuck batch's line starts with `waiting for you:` and what for; its count line keeps the command's word.

`foedrum brew`, `replay` and `resume` still name the lane, and every `Next:` line is as it was, but for a split order's, which says each pull request comes to you to merge.
