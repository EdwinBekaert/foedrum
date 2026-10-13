# 0005. Typed step outcomes via out docs

Date: 2026-10-13 · Status: Accepted

## Context
If "done" is inferred from side effects — a process exiting, a commit appearing, a file being written — then an agent that exits cleanly without doing the work, or writes a report in the wrong place, leaves the pipeline in an undefined state. Separate message channels between agents and the orchestrator add wiring and prompt text for little benefit.

## Decision
- Every step ends in exactly one `StepOutcome`: `succeeded`, `failed { retryable }`, `needs_input { questions }` or `cancelled`.
- A brewer reports its outcome through a single **out doc**: a Markdown file starting with JSON frontmatter (`status`, `summary`, `assumptions`, `questions`, `blockerKind`, plus brewer-specific fields), validated against a zod schema.
- A missing or invalid out doc is a failure, never success. "No change needed" is an explicit value.
- Deterministic **guards** run after every attempt (commits present, no tests removed, nothing pushed, scope respected, diff limits).
- There is **one channel**: in-docs → brewer → out doc. Progress comes from the CLI event stream, not from messages written by the brewer.
- `blockerKind` routes blocked outcomes: `findings` → next loop round; `environment` → Stuck immediately; `divergence` → Stuck with plan-versus-reality context.

## Consequences
- The engine always knows what happened; there is no "exited but unknown" state.
- The shared prompt contract stays around 300 tokens.
- Brewers hand distilled documents to each other instead of histories, keeping contexts small.

## Alternatives considered
- **Inbox/outbox message files** with several message types: more prompt text, more wiring, unread-message states to track.
- **Structured output via an SDK:** unavailable with the CLI-based runner (0003); frontmatter validation gives the same guarantee.
