# 0028. The brewer runner: how an attempt ends, its environment, and testFirst when unset

Date: 2026-10-15 · Status: Accepted · Amended by [0042](0042-the-claude-command-line-and-stream-contract.md)

## Context
[ADR 0003](0003-drive-the-claude-cli.md) puts the `claude` CLI behind an internal `BrewerRunner` interface with a fake for tests, and [ADR 0005](0005-typed-step-outcomes-and-out-docs.md) makes every attempt end in one typed outcome. Neither says how what a process did (its exit, its stream, its out doc) becomes that outcome. A real runner and a fake that each decided this on their own would drift apart, and the engine tests would prove the fake's rules, not the real ones. #11 also asks for a fake runner that plays every failure the engine must survive: a hang, a crash mid-step, garbage output, a missing out doc, an exceeded budget, questions, and a storm of permission denials.

Two follow-ups of #52 land here too. A brewer's `env` adds variables on top of a minimal base, and the schema only rejects reserved names early (#81). And the recipe schema leaves `testFirst` unset when a recipe does not say, because [ADR 0017](0017-test-first-recipes-and-tasting-lenses.md) defaults it to `true` only for recipes that write code, which the schema cannot see.

## Decision

### The runner interface
- `BrewerRunner` (`src/engine/brewer-runner.ts`) has `start(attempt)`, which returns a running attempt: a promise of how it ended, and `stop()`, which ends the process tree and makes the attempt `cancelled`. The runner is also the supervisor's `ProgressSource` ([ADR 0027](0027-supervisor-lost-and-stalled-attempts.md)): it reports each attempt it runs, and nothing for one it does not.
- An attempt ends in an `Ending`: a `StepOutcome`, or a brewer's `blocked` out doc with its blocker kind, which `decide` records as a final failure and routes ([ADR 0025](0025-batch-lifecycle-stuck-reminders-and-rewind.md)).

### One rule for how an attempt ends
`settleAttempt(facts, limits)` is pure and shared by the real runner and the fake. The facts are what the runner saw: how the process ended (exited with a code, killed by a signal the runner did not send, stopped by the runner, or not startable), the out doc's text, the first stream line that was not stream-json, the permission denials (every one counted, and each denied tool named once, in the order first denied: `noteDenial`, so the list stays bounded however long a storm lasts) and the turns. The first rule that applies wins:

| Facts | Ending |
|---|---|
| The process could not start | `failed`, not retryable |
| Denials reached `maxDenials` | `blocked` + `environment` (Stuck at once), naming the denied tools ([ADR 0006](0006-no-mid-run-questions.md)) |
| Turns past `maxTurns` (budget exceeded) | `failed`, not retryable |
| Stopped by the runner within its limits | `cancelled` |
| Killed by a signal, or exited with another code than 0 (a crash) | `failed`, retryable |
| A stream line that is not stream-json (garbage) | `failed`, retryable |
| No out doc, or an invalid one | `failed`, retryable |
| Out doc `done` · `needs_input` · `blocked` · `failed` | `succeeded` with the frontmatter · `needs_input` · `blocked` · `failed`, retryable |

- A limit comes first: the runner stops the process when one is reached, so the stop is its consequence, not a cancel. Denials come before the budget, because the environment is what a human must fix.
- A crash or garbage beats a valid out doc: a process that died or wrote what the runner cannot read may have left the work half done.
- An unstartable process and an exceeded budget are not retryable: the next attempt would meet the same missing CLI or the same budget. The batch is Stuck (`attempts_exhausted`) after one attempt.
- The out doc is read with the brewer's own schema, so brewer-specific fields (a review verdict) pass. A reason quotes at most 120 characters of a garbage line, as JSON.
- A process that dies together with the runner that ran it leaves no facts: nobody renews its lease, and the supervisor loses and retries it (ADR 0027).

### The environment of a brewer
`buildBrewerEnv` (`src/engine/brewer-env.ts`) merges three layers in order: the minimal base (never the engine's own `process.env`), the brewer's `env`, and the runner's forced variables last. A later layer replaces a name of an earlier one. On Windows names are compared without case (`envNameKey`, in the platform layer: `src/platform/env.ts`), and the later layer's spelling is kept, so neither `Path` from the base nor `path` from a brewer can shadow the forced `PATH`. On other platforms names that differ by case are different variables, and both stay. The platform is passed in, so every platform is tested on every platform.

### testFirst when a recipe does not say
`resolveRecipe` (`src/engine/resolve-recipe.ts`) turns a recipe file into the recipe a batch uses, with a required `testFirst`: the recipe's own value when it has one, else `true` when any brewer it names, including those in loops and parallel groups and a session step's fallback, produces `commits`, else `false`. A recipe that names a brewer the Brewery does not have is refused. An unset value therefore never reaches the engine, as off or otherwise. The router's override with its reason (ADR 0017) is recorded when routing writes it.

### The fake runner and engine tests
The fake runner (`test/helpers/fake-brewer-runner.ts`) plays a script per step: an attempt that ends at once with given facts, one that hangs reporting progress until it is stopped, or one that is lost with its runner. Settled attempts go through `settleAttempt`. A small test driver (`test/helpers/brewing.ts`) starts each scheduled attempt with a lease, finishes it through `decide`, renews the lease of every attempt the runner reports, runs the supervisor's ticks and stops the attempts that Stuck abandoned. Each behaviour has an end-to-end test against the in-memory store with a clock the test moves.

## Consequences
- The engine is testable without the real CLI: every behaviour of #11 ends in a known lane and events.
- The real runner (with #12's process runner) only gathers the facts: it parses the stream, counts denials and turns, stops the process at a limit, and reads the out doc. A new way to end means a new fact and a row in the table.
- Retrying a non-retryable failure is a human's `retry` from Stuck.
- Who renews leases in production, the runner or the driver, is settled with the real runner; the test driver renews them while the runner reports the attempt, as a live process would.
- Sessions (resume on `retryMode` and on `answer`) are left to the real runner, which learns the session id from the stream.
- Nothing loads a recipe for a batch yet, so nothing calls `resolveRecipe`: the recipe loader must, when it lands (with the test-first recipes of #25 at the latest), and nothing may read `testFirst` from a recipe file directly.
- The out doc is model output, and its text reaches the event log (a `succeeded` output, a reason, a Stuck summary). The real runner must cap the size of the out doc it reads, so an oversized one is invalid before `settleAttempt` sees it; only the garbage line, which comes from the stream, is cut here.

## Alternatives considered
- **The fake returns endings directly:** simpler, but the engine tests would then prove nothing about how a real crash, missing out doc or denial storm ends.
- **A retryable budget failure:** keeps a batch moving, but spends the attempt on a budget that runs out again.
- **The out doc wins over a crash:** keeps work that may be done, but a half-finished attempt could pass as done.
- **Case-insensitive names on every platform:** one rule, but on Linux and macOS it would drop a brewer variable that is really distinct.
- **Default testFirst to `true` whenever it is unset:** safe, but it would put a Gauger and a red proof in front of recipes that write no code.
