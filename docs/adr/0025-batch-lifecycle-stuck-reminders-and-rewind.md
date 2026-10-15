# 0025. Batch lifecycle: a reminder on Stuck, rewind only from Stuck

Date: 2026-10-15 · Status: Accepted · Amends [0019](0019-interactive-sessions-and-one-command-layer.md)

## Context
Invariant I1 says every non-terminal batch has exactly one pending action with a deadline. Stuck is not terminal, but the event store (#6) clears every deadline of a batch on `batch.stuck`: a Stuck batch had no deadline at all. The engine rules say every wait has a deadline and a batch must never be able to sit silently, and [ADR 0019](0019-interactive-sessions-and-one-command-layer.md) already promises "a reminder and a deadline" for a session step waiting in the Stuck lane. Either the store's behaviour or I1 had to change.

`rewind` raises a related question (#9). The store clears deadlines on `batch.stuck`, `batch.on_tap` and `batch.cancelled`, not on `batch.rewound`. If a brewing batch could be rewound, the attempts in flight would be abandoned while their deadlines stayed, so the supervisor would make the batch Stuck for no reason, and their leases would need releasing in the same transaction.

The lifecycle diagram in architecture §4.3 also leaves open which lanes each command and event may start from, and the fold deliberately records whatever the events say. The command layer needs one answer before anything is appended.

## Decision

### A Stuck batch has a reminder
- `batch.stuck` carries a required `remindAt`, like `batch.waiting`. The Stuck lane keeps it.
- The store replaces a batch's deadlines with that reminder on `batch.stuck`: the step deadlines go, the reminder row is set. `step.scheduled` ends it, as it ends a Conditioning reminder.
- When the reminder is due, the supervisor issues `remind`: the batch is Stuck again with the same reason and options and the next reminder (default every 2 days, like Conditioning). A Stuck batch is visible and nags; it is never silent.
- I1 keeps its wording; its note now reads "for Conditioning and Stuck batches: a reminder deadline".
- Getting Stuck **abandons** every attempt of the batch that has not finished: the fold marks it, and the guard refuses a late `step.started` or `step.finished` of it. Whatever moves the batch on (retry, skip, answer, recipe, rewind) schedules new attempts, so a brewer process that returns after its deadline cannot move the batch a second time.

### Rewind only from Stuck
- `rewind` is allowed only while the batch is Stuck and the Stuck event offers it. It is refused in every other lane. In Stuck the attempts in flight are already abandoned and the batch's deadlines already replaced, so `batch.rewound` needs no deadline or lease handling in the store.
- A rewind names the commit of each repository it resets (`shas`, at least one). A sub-order's batch names exactly its own repository; the guard checks both. The step must be one of the current recipe, which may differ from the recipe that ran it. It appends `batch.rewound` and schedules the next attempt of the step it goes back to.
- To rewind a batch that is brewing, a human first gets it Stuck (or cancels it). That costs one extra step for a rare action, and keeps one place where in-flight attempts are abandoned.

### Lanes and transitions
`on_tap` and `cancelled` are terminal: nothing changes a batch's lane after them. The guard before append (`src/engine/admit.ts`) refuses an event outside these lanes:

| Event | Allowed while the batch is |
|---|---|
| `batch.recipe_chosen` | ordered, conditioning, stuck |
| `step.scheduled` | ordered, brewing, conditioning |
| `step.started`, `step.finished` | brewing, and only for the step's latest attempt, when Stuck did not abandon it |
| `input.received` | stuck on `needs_input` for that step |
| `batch.stuck` | brewing, stuck |
| `batch.resumed`, `batch.rewound` | stuck, when its options offer the action; a rewind with its commits as above |
| `batch.waiting` | ordered, conditioning |
| `batch.on_tap` | brewing |
| `batch.cancelled`, `order.decomposed` | any lane but on tap and cancelled |

Conditioning is entered before brewing starts, while a batch waits for a merge, a release or a sibling (§3.2). Routing the batch (`route`, or a human's `recipe`) ends it. Entering Conditioning between steps waits until a recipe step needs it, because it must first know which attempts are still in flight.

### One decision layer
- `decide(state, command, context)` (`src/engine/decide.ts`) is the core of the command layer ([ADR 0019](0019-interactive-sessions-and-one-command-layer.md)). It takes the folded state and one command and returns the events to append, or a refusal. Each event goes through the guard against the state the events before it lead to, so no command can produce what the guard refuses. It is pure: the caller passes the time and the reminder interval.
- Every human command is recorded with who issued it and from where ([ADR 0019](0019-interactive-sessions-and-one-command-layer.md)): `decide` copies `by` and `via` from the command onto its events. `batch.cancelled` and `batch.rewound` carry `via`, and `batch.recipe_chosen` is split on `source` (`label`, `router` or `human`), so a human's choice requires `by` (the issuer's name, as on every event) and `via`, and a label's or the router's has neither. `retry`, `skip` and `answer` already record both in `batch.resumed`.
- Commands are TypeScript types of the engine. The surfaces that parse untrusted input into them (#37) give them zod schemas in `src/schemas/`; until then nothing outside the engine builds one, and every event a command produces is still parsed by the guard.
- Commands: the human commands `retry`, `skip`, `answer`, `recipe`, `rewind` and `cancel`, and the engine's `route`, `finish`, `expire` (a deadline passed, invariant I5), `wait`, `remind` and `record` (events that decide nothing, such as `batch.ordered` or `effect.applied`). Every `switch` over commands, endings, blocker kinds, stuck reasons, continuations and lanes ends in a `never` check, so a new kind does not compile until it is handled.
- A recipe is asked only what it knows, through a small `Recipe` interface (`src/engine/recipes.ts`): the first step, whether it has a step, a step's deadline, what follows a step, whether a step may retry, and where an `onFail` or `onBlocked: findings` route goes. The state machine handles the outcomes itself:

| Ending | Next |
|---|---|
| `succeeded` | the next step, or on tap when the recipe is done |
| `failed` | another attempt while retryable and attempts are left; else the `onFail` route; else Stuck (`attempts_exhausted`) |
| `cancelled` | another attempt while attempts are left; else Stuck (`attempts_exhausted`) |
| `needs_input` | Stuck with the questions; `answer` resumes the step |
| `blocked` + `findings` | the `onBlocked` route; else Stuck |
| `blocked` + `environment` or `divergence` | Stuck at once |

- A `blocked` out doc is recorded as `step.finished` with `failed { retryable: false }` and the blocker kind in the reason. `StepOutcome` stays the single contract of [ADR 0005](0005-typed-step-outcomes-and-out-docs.md).
- Every Stuck reason offers `retry`, `skip`, `recipe`, `rewind` and `cancel`; `needs_input` also offers `answer`. `cancel` is always allowed in a non-terminal lane.
- The guard also refuses what the fold throws on (#8). It also keeps a sub-order in its repository once it has batches, and lets a bottle bundle only existing sub-orders of its own repository with a batch on tap ([ADR 0013](0013-single-repo-sub-orders-bottles-and-releases.md)).

## Consequences
- I1 holds for Stuck batches without rewording it, and the supervisor (#10) has one mechanism, reminders, for Conditioning and Stuck.
- `batch.stuck` changed shape. There is no stored state from before this change outside tests.
- A rewind of a brewing batch takes two commands. The store needs no `batch.rewound` case, and no lease release is tied to it.
- Recipe files (#52) can be written against a small interface; tests use a fake.
- Entering Conditioning from brewing, and parallel groups (several attempts in flight in one batch), need their own transitions when recipes use them.

## Alternatives considered
- **Reword I1 to exempt Stuck:** the smallest change, but it makes Stuck the one silent wait. That contradicts the engine rule that every wait has a deadline, and ADR 0019's reminder for session steps.
- **A separate `batch.reminded` event:** one more event type, file placement and fold case for what `batch.waiting` and `batch.stuck` already express with a new `remindAt`.
- **Rewind while brewing as well:** saves a command, but `batch.rewound` would have to clear deadlines and release leases of abandoned attempts in one transaction, and a late `step.finished` of an abandoned attempt would need its own rule.
- **Let the recipe decide the next step from the outcome:** less code here, but each recipe implementation would repeat the outcome routing, and a new outcome kind would not fail the type check in one place.
