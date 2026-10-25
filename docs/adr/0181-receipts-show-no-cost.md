# 0181. Receipts show no cost

Date: 2026-10-25 · Status: Accepted · Supersedes the cost parts of [0172](0172-an-attempt-s-receipt-from-its-stream.md) (the receipt's `costUsd` and each model's, the estimated cost on each line, the session share, the summed cost) · Amends [0042](0042-the-claude-command-line-and-stream-contract.md) (the runner no longer reads `total_cost_usd`) and [0072](0072-the-status-comment-edits-as-revisions-in-the-ledger.md) (the status comment never shows a cost, where 0072 left it for later)

## Context
ADR 0172 records claude's `total_cost_usd` on each attempt's receipt as `costUsd`, and each model's `costUSD` under `models`. The status comment's Receipts line shows it as an estimate, a resumed attempt's as its own share of the session or, without the receipt before it, as the session's, and `foedrum status` sums it per batch (#483).

The figure is claude's list price. Each user pays by their own plan: a subscription, the API at their own rates, an enterprise agreement. A dollar amount therefore says nothing true about what a brew cost them, and in a public pull request or a shared status comment it reads as a fact, `est.` or not. Tokens, turns and time are the same for everyone.

## Decision
- **The runner no longer reads a cost.** It reads neither the result's `total_cost_usd` nor a model's `costUSD` in `modelUsage`; a new receipt has no `costUsd`, and its `models` hold each model's tokens only.
- **Nothing shows a dollar amount**: not the status comment's Receipts lines, `foedrum status`, `foedrum brewers`, `foedrum replay` nor the pull request. A receipt line ends after its tokens and denials: `` `implement #1` · 2m 38s · 31 turns · 1.34M tokens · 2 denied (Bash: git push) ``, and a batch's total in `foedrum status` likewise (`3 attempts / 5m 10s / 52 turns / 2.1M tokens / 2 denied`).
- **An event recorded before this record still reads.** The event schema accepts a receipt's `costUsd` and a model's, and drops them when it parses the event, so the fold, `foedrum replay` and the state branch's comparison of local and pushed events never see them. A line a crashed flush left on the state worktree is compared with the pending event as the store reads it too, so an older Foedrum's line is replaced, not taken for another engine's.
- **The session share goes with the cost.** It existed only because a resumed run reports its session's cost so far. A resumed attempt's tokens stay as ADR 0172 counts them: `step.finished`'s `usage`, which covers the run alone. `resumed` stays on the receipt: it still says that `apiDurationMs` and `models` are the session's.

The rest of ADR 0172 stands. Its example lines are history and stay.

## Consequences
- The status comment, `foedrum status` and the pull request show the same figures to everyone who reads them.
- An old receipt's cost stays in the stored event's text on the state branch until that log is rewritten, which it never is; nothing reads it.
- ADR 0042's rule that the cost is never summed across attempts has nothing left to apply to.
- Summing cost in `foedrum brewers`, which ADR 0172 left for later, is dropped.
