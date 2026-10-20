# 0091. A run-out usage window blocks on the environment

Date: 2026-10-20 · Status: Accepted · Amends [0047](0047-the-claude-brewer-runner-its-stream-endings-and-progress.md)

## Context
When a usage window of a Claude subscription runs out, claude refuses every request until the window resets. Claude Code's error reference ([code.claude.com/docs/en/errors](https://code.claude.com/docs/en/errors), "Usage limits", read 2026-10-20) gives the messages:

```text
You've hit your session limit · resets 3:45pm
You've hit your weekly limit · resets Mon 12:00am
You've hit your Opus limit · resets 3:45pm
You've hit your Sonnet limit · resets 3:45pm
```

and says that "Claude Code blocks further requests until the reset time shown in the message". ADR 0047 reads any error a `result` reported (`is_error`) as a failure that may pass, so a run-out window spends the step's retries on the same refusal and the batch goes Stuck as `attempts_exhausted`, with a reason that does not say the window is the cause (#238). Waiting for the reset and starting again on its own is #242, not this decision.

## Decision

### What the runner relies on
Every claim here comes from the docs, never from claude: claude cannot be made to hit a limit, so there is no captured stream and no real-claude test.
- **The text.** The whole text, trimmed, is one line of exactly one of the four forms above: `You've hit your ` (a straight apostrophe), then `session`, `weekly`, `Opus` or `Sonnet`, then ` limit · resets ` (a middle dot, U+00B7, between single spaces), then the reset, which is everything after it and starts with a character that is not a space. The reset is kept as claude wrote it (`3:45pm`, `Mon 12:00am`), cut to 200 characters like any text the stream gives.
- **Where it is.** In a `result` event with `is_error: true`, as its `result` or as one of its `errors`. The headless docs say a failure inside the run is printed "as the result on stdout", and the Agent SDK's `SDKResultMessage` has a `result` string on its `success` arm and an `errors` array on its error arms.
- **What the docs leave open**, and the runner does not depend on: which `subtype` a usage limit ends with (`success` with `is_error`, or `error_during_execution`); whether `is_error` is `true`, which ADR 0042's rule (`is_error` decides) needs and the runner requires; the `terminal_reason` and `api_error_status`; and whether an `assistant` message with `error: 'rate_limit'` or a `rate_limit_event` with `status: 'rejected'` comes first. Both stay as ADR 0047 reads them: neither is a fact of its own.

Anything else stays a retryable error, as before: a curly apostrophe, the message inside other text, another separator, a limit the docs do not name (`Haiku`), the warning before a window runs out (`You've used 85% of your session limit · resets 3:45pm`), the interactive wait's line (`Usage limit reached · limit resets 3:45pm`), a spend limit (`You've hit your monthly spend limit`, `You've hit your individual usage limit`) and the server's throttle (`Server is temporarily limiting requests (not your usage limit)`). A result that reported no error, and a model's reply, never name a limit, whatever their text: only claude's own error result can.

### How the attempt ends
`readClaudeStream` reads the documented form into the new `usageLimit` fact (the limit and its reset). ADR 0047's table gains one row, right after the session claude did not set up:

| Facts | Ending |
|---|---|
| claude did not set up the session that was asked | `blocked` + `environment` (Stuck at once) |
| **The error result said a usage window ran out** | **`blocked` + `environment`: `claude hit its <limit> limit, which resets <reset>: retry the step after that`** |
| The process could not start | `failed`, not retryable |
| … | as ADR 0047 |

- It comes before every other rule but the session's: an exit code, the error the result reported, a missing out doc and a budget past `maxTurns` all follow from the refusal.
- `foedrum stuck` and the status comment show it as any blocked summary: `blocked at <step> (environment): …`. The reset is claude's text, not the model's, and the status comment still shows it as plain text ([ADR 0072](0072-the-status-comment-edits-as-revisions-in-the-ledger.md)).
- A human runs `foedrum retry` after the reset.

## Consequences
- A run-out window costs one attempt, not the step's retries, and the lane says why and until when.
- A new message form in Claude Code (another limit, a reworded line) falls back to a retryable failure, as before this decision: the docs are the place to look first, and a change here is a new row in the list above.
- The reset is shown as claude wrote it, in the time zone of the machine that ran claude: Foedrum does not read it as a time. #242 needs a time to wait for, and settles how it reads one.

## Alternatives considered
- **Match `limit` and `resets` anywhere in the text:** catches forms the docs do not give, and spend limits and the warning, which do not block until a reset or do not block at all.
- **Read the `rate_limit` assistant error or a rejected `rate_limit_event`:** the docs give neither the text nor the order of these for a usage limit, and a 429 that passes looks the same.
- **A failure that is not retried (`attempts_exhausted` after one):** stops the retries too, but hides that the subscription, not the step, needs the wait.
- **Wait for the reset in the runner:** that is #242, which pauses every model call of the Brewery, not one attempt.
