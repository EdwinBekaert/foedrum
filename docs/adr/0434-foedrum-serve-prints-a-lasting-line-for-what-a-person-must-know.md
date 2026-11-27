# 0434. `foedrum serve` prints a lasting line for what a person must know

Date: 2026-11-27 · Status: Accepted · Amends [0272](0272-the-status-comment-names-a-pull-request-once-and-breaks-its-path-per-round.md) (`serve`'s cleanup line: it is no longer `formatNotice`'s), [0359](0359-the-intake-takes-an-issue-only-when-someone-in-users-added-its-labels.md) (the line of a failed read of who labelled an issue: no raw error on a terminal, and it says the next pass tries again) and [0427](0427-foedrum-serve-keeps-a-live-line-on-a-terminal.md) (what its lasting lines are)

## Context
In an hour `foedrum serve` opened a Brewery issue, ran about 25 steps, got two batches Stuck and opened a pull request, and printed only `still running for <brewery>` and the driver's and the intake's notices (#1179). Its cleanup line spoke the engine's words (`cleaned batch foedrum-1156: removed 20 worktrees; deleted 19 branches; …`) and carried no pull request. A failed read of GitHub printed the raw, localised socket error with no word that the next pass tries again.

## Decision
- After each tick, `serve` compares each batch's folded state with the state of the tick before, as `brew` compares its batch's, and prints a lasting line for each change a person must know: a step's attempt that ended (`#12 brew #1 succeeded (2m 5s, 1,200 input, 340 output tokens)`: its time from the attempt's receipt, its tokens from its `usage`, and neither when it reports none), a batch that got Stuck (what it is Stuck for and the command to type for each option), a pull request that opened (its link, once for the Cellar's run: a batch sent back to brew a fix goes on tap again with the same pull request and says nothing), and a pull request that merged or was closed without merging. A batch is named as `status` names it. A reminder that makes a batch Stuck again for the same stop adds no line; a batch moved on and Stuck again does. The driver gets no new notice.
- Every such line goes over the live line (ADR 0427), and a batch that only brews prints none.
- The cleanup line is a person's: `#27 (foedrum#1156) opened pull request #1167; cleaned its 20 working copies, keeping its last branch in case a check on the pull request fails`. The batch's pull request is read from `serve`'s state, since the notice carries none. A tick's cleanup lines follow its other lasting lines. A branch kept for another reason, and what could not be cleaned, follow in the engine's words. `formatNotice` keeps its cleanup line for `brew`.
- A failed read of GitHub by the intake says in one line what failed and that the next pass tries again. The raw error follows it only where no live line is drawn.
- The words are in `src/cli/serve-lines.ts`, pure over two folded states and the set of pull requests said opened, which `serve` keeps from tick to tick and `lastingLines` adds to.

## Consequences
- A person who watches `serve` on a terminal, or reads its log, learns of a Stuck batch and its command, and of a pull request, without running `status`.
- A line of a step's end for each attempt of a batch makes the log longer; a check step's has no time and no tokens.
- A batch that a second Cellar drives, and that this one reads, prints its lines in both.
