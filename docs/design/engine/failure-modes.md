# Failure modes designed out

Agent orchestrators typically get stuck in a handful of ways.
Foedrum removes each class structurally instead of patching instances.

| Failure class | Typical symptoms | Mechanism |
|---|---|---|
| **Agent process observed from outside** | orphaned sessions, "alive but idle" processes, sessions outliving the orchestrator, spawn errors | The engine spawns and owns the child process, reads its stream live, renews a lease while it runs, and kills the process tree on deadline/stall/cancel. On restart, recorded process trees are killed — there is no "maybe alive" state |
| **"Done" inferred from side effects** | agent exits 0 without doing work, missing report, unread messages | A brewer is done only when it writes a valid **out doc** (JSON frontmatter validated by schema). "No changes needed" is an explicit value, never an absence. Deterministic guards check commits, removed tests, scope |
| **State spread over many stores** | reconcile/orphan/stale fixes, drift between files | One event log (durable on the Brewery's state branch, indexed locally in SQLite); everything else is a projection |
| **Agents asking humans mid-run** | sessions parked on a question, resume failures | Brewers never ask mid-run. A question is an outcome (`needs_input`); the answer starts the next attempt ([ADR 0006](../../adr/0006-no-mid-run-questions.md)), or, at a step that chooses the recipe, starts the chosen recipe ([ADR 0232](../../adr/0232-foedrum-mash-routes-an-issue-to-the-innkeeper-whose-question-the-answer-chooses-the-recipe-by.md)) |
| **Unbounded loops** | "another round?" decisions, review/fix cycles that never converge | Every loop has `max_rounds`; exhaustion → Stuck with explicit options |
| **Shared working trees** | two sessions in one checkout, merge collisions | One worktree per attempt, protected by a lease |
| **Environment problems disguised as task failures** | agents retrying an unbuildable environment, flailing on denied tools | Out docs carry `blocker_kind: environment`; repeated permission denials abort the attempt and name the missing tools → Stuck, not retry |
| **A problem found only at the end** | every later step built on a commit the push then refuses, fixed by hand | A committing brewer's `done` attempt gets the push's secret scan when it ends: a finding fails it retryably, and its retry, told why, starts without those commits; the push scans again as the last line ([ADR 0187](../../adr/0187-a-committing-brewer-s-attempt-is-scanned-for-secrets-when-it-ends-done.md)) |
| **Duplicate side effects after a crash** | two pull requests, double comments | Idempotency ledger (I4) enforced by a `UNIQUE` constraint |

The remaining risk is honest: brewers are still external processes.
Deadlines, stall detection and leases are therefore mandatory — as one generic mechanism instead of many special cases.
