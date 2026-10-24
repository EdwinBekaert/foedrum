# 0172. An attempt's receipt, from its stream

Date: 2026-10-24 · Status: Accepted · Amends [0047](0047-the-claude-brewer-runner-its-stream-endings-and-progress.md) (the runner reads what an attempt took, not only how it ended)

## Context
The runner reads claude's `stream-json` line by line (ADR 0042, ADR 0046, ADR 0047). From the last event, `result`, it kept `is_error`, `num_turns` and `usage`. Of the permission denials it kept a count and the tool names, each once. `result` holds more: `total_cost_usd`, `duration_ms`, `duration_api_ms` and `modelUsage`, the tokens and cost per model. The captured streams in `test/fixtures/claude-stream/` hold all of these fields (claude 2.1.301), and nothing in `src/` read them.

So a person looking at a batch could not tell which attempt was expensive, which was slow, or which kept hitting the same refused rule (#447). The status comment shows how each step ended. `foedrum status` shows each batch's lane.

## Decision
- **Each attempt whose stream the runner read ends with a receipt**: `receipt` on `AttemptEnd`, which the driver records on the attempt's `step.finished` and the fold keeps on the finished attempt. The receipt holds:
  - `complete`: whether a `result` event was read;
  - `durationMs`, `apiDurationMs`: the result's `duration_ms` and `duration_api_ms`. Without a result, `durationMs` is the time from claude's start to the last line seen, and `apiDurationMs` is absent;
  - `turns`: the result's `num_turns`, else the main thread's messages seen (as `turns` already counts them, ADR 0047);
  - `costUsd`: the result's `total_cost_usd`, when there is one;
  - `models`: `modelUsage` by model, with that model's tokens and `costUSD`, when the result has them;
  - `edits`: the calls of the file tools (`Write`, `Edit`, `MultiEdit`, `NotebookEdit`) that came back without an error;
  - `toolErrors`: the tool results that came back as an error, apart from denied calls;
  - `denied`: one entry per tool family (the denial's `tool_name`, such as `Bash`, `PowerShell`, `Edit`, `Read`), in the order each was first denied, with its count and, for `Bash` and `PowerShell`, the command prefixes it refused. A prefix is the first one or two words of the denied call's command, each word only letters, digits, `.`, `_` and `-` and at most 32 characters. At most five prefixes per family are kept, each once. The rest of a command is model output and stays out, so the prefix (`git push`) names the rule without the arguments.
- **The tokens stay in `step.finished`'s `usage`**, which already owns them (ADR 0159 sums them). The receipt does not repeat the total.
- **A run with no `result` gets a receipt of what was seen**, marked `complete: false`: a run the runner stopped (deadline, stall, cancel, a limit it saw), killed by a signal, or past an output limit. An attempt that never started claude has none (no plan, settings that could not be written, a setup that did not pass, claude missing). An attempt the supervisor finds lost has none either, since the runner that read its stream is gone with its driver (ADR 0027).
- **Where a batch is shown, each attempt with a receipt gets one line**: `` `implement #1` · 2m 38s · 31 turns · 1.34M tokens · $0.82 est. · 2 denied (Bash: git push) ``. The tokens are the four kinds of `usage` added up. A part with nothing to show is left out, and an incomplete receipt ends with `· incomplete`. Cost is always written as `est.`: claude reports list prices, and on a subscription that is not what the user pays.
  - The status comment lists them under **Receipts**, in the order the attempts ran, at most 30 lines and one that counts the rest. The prefixes are model output, so they go through the comment's escaping and secret filter (ADR 0088).
  - `foedrum status` adds each batch's total to its row: the attempts with a receipt, then their summed duration, turns, tokens, cost and denials (`3 attempts · 5m 10s · 52 turns · 2.1M tokens · $1.20 est. · 2 denied`). It takes no batch argument. One row per batch already names the batch, and a second output mode would add a positional, a plugin skill change and its parity test for the same number.
- **The pull request's "How this was brewed" table** reads the receipts from the event log once #450 builds it. This record does not change the pull request body.

## Consequences
- The status comment changes whenever a brewer attempt finishes. It already did, since the step line changes too, so no extra revision is due.
- An event log from before this record has no receipts. Those attempts show no receipt line, and their batch's total counts only the attempts that have one.
- `foedrum brewers` (ADR 0159) still sums tokens only. Summing cost there is a later change that reads the same field.
- The receipt is the runner's reading of a stream it does not trust. Every count is a non-negative integer, the cost a non-negative number, and the strings are cut, so a stream cannot make the event large. A stream of many distinct denied tools grows `denied` as it already grew `deniedTools` (ADR 0047).
