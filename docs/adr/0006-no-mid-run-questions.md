# 0006. Brewers never ask questions mid-run

Date: 2026-10-13 · Status: Accepted · Amended by [0118](0118-retrymode-resume-loads-and-an-answer-resumes-the-session-that-asked.md)

## Context
In a headless session there is nobody to answer an interactive question. With a permission mode that never prompts, an `AskUserQuestion` call is either denied or leaves the session parked, and the orchestrator must detect, queue and resume it — a major source of stuck pipelines.

## Decision
- `AskUserQuestion` is in every brewer's deny list.
- **A question is an outcome.** The brewer finishes with `status: needs_input` and a list of questions, each with options, a recommended option and why it blocks.
- **Decide and record by default.** The contract tells brewers to take a reasonable default and list it under `assumptions` whenever one exists; ask only when a wrong guess would likely waste the run. Assumptions are shown in the order's status comment for review without blocking.
- The batch moves to Stuck 🔔; the engine posts the questions on the order. The answer (`/foedrum answer …`) starts the next attempt: `--resume` with the answers when the session was kept, otherwise a fresh attempt with a `qa.md` in-doc.
- Permission denials are counted; above a threshold the attempt aborts with `blockerKind: environment`, naming the denied tools.

## Consequences
- No session is ever waiting on a human; nothing needs to be kept alive.
- Fewer interruptions: most uncertainty becomes reviewable assumptions.
- A resumed session after a long wait may have a cold prompt cache — acceptable.

## Alternatives considered
- **Allow interactive questions and resume later:** the main source of parked sessions and complex recovery code.
- **Forbid questions entirely:** brewers would guess on genuinely blocking ambiguities and waste whole runs.
