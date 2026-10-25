# Step outcome: the single contract

Every step ends in one outcome, defined in [`src/schemas/step-outcome.ts`](../../../src/schemas/step-outcome.ts):

| Kind | Carries |
|---|---|
| `succeeded` | the step's output |
| `failed` | whether it is retryable, the reason, and `overran: "turns"` when a brewer's run went past its turn budget and its retry resumes the session ([ADR 0175](../../adr/0175-a-turn-overrun-is-retried-by-resuming-its-session-and-keeps-its-out-doc.md)), and `secrets: true` when the secret scan found what the push would refuse in a `done` attempt's commits, so its retry is told why ([ADR 0187](../../adr/0187-a-committing-brewer-s-attempt-is-scanned-for-secrets-when-it-ends-done.md)) |
| `needs_input` | the questions |
| `cancelled` | nothing |

Every step kind (brewer, check, human gate, action, fan-out) ends in exactly one of these kinds.
An exhaustive `switch` makes an unhandled outcome a compile error ([ADR 0005](../../adr/0005-typed-step-outcomes-and-out-docs.md)).

How a brewer attempt reaches its outcome: [how a brewer runs](../recipes/how-a-brewer-runs.md).
