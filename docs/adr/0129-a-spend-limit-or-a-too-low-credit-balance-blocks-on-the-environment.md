# 0129. A spend limit or a too-low credit balance blocks on the environment

Date: 2026-10-22 · Status: Accepted · Amends [0091](0091-a-run-out-usage-window-blocks-on-the-environment.md)

## Context
[ADR 0091](0091-a-run-out-usage-window-blocks-on-the-environment.md) reads the four usage-window messages of Claude Code's error reference and leaves a spend limit (`You've hit your monthly spend limit`) a retryable error, because a spend limit "does not block until a reset". It blocks for longer than that: until a human acts. The same reference ([code.claude.com/docs/en/errors](https://code.claude.com/docs/en/errors), "You've hit your monthly spend limit" and "Credit balance is too low", read 2026-10-22) gives:

```text
You've hit your monthly spend limit · raise it at https://claude.ai/settings/usage?from=cc_cli_limit_message
You've hit your individual spend limit · ask your admin for a higher limit
You've hit your org's monthly spend limit · visit https://claude.ai/admin-settings/usage to raise it
You've hit your team's shared budget · ask your admin to raise it at https://claude.ai/admin-settings/usage
You've hit your channel's monthly spend limit · an org owner or channel manager can raise it in the channel's Claude settings
Credit balance is too low
```

It says that "the text after the `·` says how to get that limit increased, and varies with your plan and whether you manage billing"; that on usage-based billing the message says `usage limit` in place of `spend limit`, "as in `You've hit your individual usage limit`"; and that when a plan window is what ran out, "the message also says when that window resets, for example `· your session limit resets 3:45pm`, and access returns then without anyone raising the limit". A too-low credit balance blocks "until credits are added or the request uses a working credential". Its "Automatic retries" section says Claude Code itself fails at once on a 429 that reports a spend limit or exhausted usage credits.

Today each of these is a retryable failure: the step spends its attempts on the same refusal and the batch goes Stuck as `attempts_exhausted`, with a reason that does not name the limit (#257).

ADR 0091's texts have one variable part, the reset, at a known place. These have a free text after the separator, which 0091's "the whole text is one of the documented forms" does not cover, so this is a decision of its own.

## Decision

### What the runner relies on
As in ADR 0091, every claim comes from the docs, never from claude: there is no captured stream and no real-claude test.
- **Where it is.** The same place as a usage limit: a `result` event with `is_error: true`, as its `result` or one of its `errors`. A result that reported no error, and a model's reply, never name a spend limit.
- **A spend limit.** The whole text, trimmed, is one line: `You've hit your ` (a straight apostrophe), then exactly one of `monthly spend limit`, `individual spend limit`, `org's monthly spend limit`, `channel's monthly spend limit`, `team's shared budget` or `individual usage limit`, then either nothing or ` · ` (a middle dot, U+00B7, between single spaces) and a rest that starts with a character that is not a space. The rest is how to raise the limit, which the docs say varies, so any rest matches, except one that contains `resets`: that is the plan-window form, which comes back by itself, and stays a retryable error. The headline alone matches because the docs give `You've hit your individual usage limit` without a rest.
- **A credit balance.** The whole text, trimmed, is exactly `Credit balance is too low`.

Anything else stays a retryable error, as before: a curly apostrophe, the message inside other text, another separator, a limit the docs do not name (`weekly spend limit`), the plan-window form, the gateway's `spend limit reached` (which resets on a schedule) and `spend limit unavailable` (which clears on its own), `Could not update your spend limit`, and the API's own `Your credit balance is too low to access the Anthropic API.`

### How the attempt ends
`readClaudeStream` reads the documented forms into the new `spendLimit` fact: which spend limit, or the credit balance. ADR 0047's table, as ADR 0091 left it, gains one row right after the usage limit:

| Facts | Ending |
|---|---|
| claude did not set up the session that was asked | `blocked` + `environment` (Stuck at once) |
| The error result said a usage window ran out | `blocked` + `environment` (ADR 0091) |
| **The error result named a spend limit** | **`blocked` + `environment`: `claude hit its <limit>: no request goes through until the limit is raised, then retry the step`** |
| **The error result said the credit balance is too low** | **`blocked` + `environment`: `claude's credit balance is too low: no request goes through until credits are added, then retry the step`** |
| The process could not start | `failed`, not retryable |
| … | as ADR 0047 |

- It comes after the usage limit, whose reset is the more precise thing to tell a human, and before every other rule, for ADR 0091's reason: an exit code, the error the result reported, a missing out doc and a budget past `maxTurns` all follow from the refusal.
- The summary gives no time: none comes by itself. It names the limit (whose budget to raise), not claude's how-to text, which holds URLs and varies by plan; the human who raises the limit already sees it in claude.
- A human raises the limit or adds credits, then runs `foedrum retry`.

## Consequences
- A spend limit or an empty credit balance costs one attempt, not the step's retries, and the lane says which limit.
- A new or reworded message falls back to a retryable failure, as before: the docs are the place to look first.
- The plan-window form of a spend-limit message (`· your session limit resets …`) still spends the step's retries; the docs give it only as a fragment, so its whole line is not known. Waiting for a reset is #242.

## Alternatives considered
- **Match the documented lines whole, the text after the `·` included:** the docs say that text varies with the plan, and its URLs carry a tracking parameter; a changed hint would silently turn the rule off.
- **Match `spend limit` or `credit balance` anywhere:** catches the gateway's cap, which resets on a schedule, the failed limit change, and text the model wrote.
- **Quote claude's how-to text in the summary:** untrusted, varies, and holds URLs that go into the event log and the status comment, for a hint the human already has in claude.
- **Read the 429 or `billing_error` of an assistant message:** the docs give neither its text nor its order for a spend limit, and ADR 0047 already reads `billing_error` before the first reply.
