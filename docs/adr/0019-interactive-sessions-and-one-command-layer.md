# 0019. Interactive sessions, the autonomous Cellar, and one command layer

Date: 2026-10-14 · Status: Accepted · Generalises [0014](0014-interactive-refinement-plugin.md) · Amended by [0025](0025-batch-lifecycle-stuck-reminders-and-rewind.md), [0030](0030-only-commands-that-change-state-are-recorded.md), [0041](0041-untrusted-input-in-per-prompt-nonce-tags.md), [0042](0042-the-claude-command-line-and-stream-contract.md), [0044](0044-batch-leases-held-by-the-driver-and-one-command-log.md) and [0105](0105-foedrum-order-orders-an-issue-again-as-a-human-command-recorded-on-batch-ordered.md)

## Context
Foedrum was designed around an always-on engine (`foedrum serve`) controlled through GitHub comments. Two things do not fit that model:

- **Judgement needs conversation.** Analysis, refinement, triage and review take many quick exchanges. Through issue comments, every exchange costs a poll cycle and a new attempt: slow, expensive and tiring. [ADR 0014](0014-interactive-refinement-plugin.md) solved this for refinement only.
- **Engineers work in Claude Code.** An engineer should be able to open `claude`, type `/foedrum:brew 21`, and brew that order with Foedrum's recipes and guarantees, without starting or running a background engine first. They should also be able to step into any brewer's session to see or continue its work.

## Decision

### Two drivers, one engine
- The deterministic engine logic (fold, state machine, recipe execution, guards, idempotency ledger) is a **library**. Two **drivers** use it:
  - **Interactive:** an engineer's Claude Code session, through the Foedrum plugin. Works without `foedrum serve`.
  - **Autonomous:** the Cellar (`foedrum serve`), which picks up orders and commands from GitHub, and later from the Brewhouse dashboard.
- In both, the engine decides what runs next; a model never does. In an interactive session, the plugin asks the engine for the next step, runs it, and reports the outcome back.
- Both write the same events to the same event store and state branch. A batch started interactively can be continued autonomously, and the reverse.

### One driver per batch at a time
- A batch is driven by exactly one driver at a time, held as a **lease with a heartbeat** (invariants I1 and I2). The Cellar skips batches leased by a session.
- Taking over a batch that the other driver holds is an explicit command. The current driver stops at the next step boundary, and the handover is recorded as an event.
- When a session ends or crashes, its lease expires and the batch becomes available again. It never sits silently: the lease has a deadline like every other wait.

### Interactive brewing
- Brewer steps run as the same headless `claude` processes, with the same per-attempt settings and guards, whichever driver starts them. The session shows their progress live.
- A brewer still never asks mid-run ([ADR 0006](0006-no-mid-run-questions.md)). When it returns `needs_input`, the session asks the engineer right away and starts the next attempt with the answers. A Stuck question costs seconds instead of a comment round trip.
- **Interactive steps** run in the engineer's session itself: analysis and refinement, triage, and review discussion. A recipe marks them with a `session` step (`{ "id": "analyze", "session": "refine" }`). Under the autonomous driver, such a step waits visibly in the Stuck lane with the reason "waiting for a session", with a reminder and a deadline; a recipe may name an automated fallback with an approval gate.

### Sessions are part of the state
- Every brewer attempt records its **Claude Code session** in the event store, and therefore on the state branch: the session id (from the CLI's first stream event), the session it resumed if any, the worktree path, and the Claude Code version. Session steps in an engineer's own session are recorded the same way.
- Answering, retrying and stepping in are defined by what they do to a session:

| Action (from any surface) | Session |
|---|---|
| `answer` | **Resume** the brewer's session; the answers are its next message |
| `retry` | Per the brewer's `retryMode`: resume the session, or start a fresh one with the same in-docs |
| `rewind <step>` | **Fresh** session from that step's in-docs, at the rewound commits |
| `recipe <name>` | Fresh sessions for the new recipe's steps |
| `resume`, takeover | **Interactive resume** of the session in the engineer's Claude Code, in the brewer's worktree |
| `skip`, `cancel`, `pause` | No session |

- A resumed session is a new attempt that names the session it continues, so the history stays a list of attempts with deadlines and outcomes.
- **One process per session.** A session can be resumed by only one process at a time; the lease covers the session as well as the attempt.
- **Fallback:** when a session cannot be resumed (the transcript is missing on this machine, or its worktree is gone and cannot be recreated at the recorded commit), the engine starts a fresh attempt with the original in-docs plus the questions and answers, and records why.
- Resuming keeps the model and effort of the original session, so the prompt cache stays valid where it is still warm.

### Stepping into any session
- Brewer sessions are persisted. `/foedrum:resume <batch> [<step>]` opens the brewer's own session (`claude --resume`) in its worktree, with the same per-attempt settings, so the engineer sees everything the brewer saw and did.
- On a finished attempt, resuming is for inspection or a follow-up; on a running batch, it takes over the batch as described above. When the engineer is done, the session writes the out doc and the engine continues from the next step.
- Sessions are stored where they ran. Resuming on the same machine is supported from the first release that runs real brewers. Resuming on another machine requires carrying the session transcript (for example on the state branch); this depends on Claude Code's session storage and is verified by a spike before it is promised.

### One command layer
- Every action is one **typed command** with one schema and one handler: `brew`, `status`, `stuck`, `answer`, `approve`, `retry`, `skip`, `rewind`, `cancel`, `pause`, `bottle`, `recipe`, `refine`, `triage`, `review`, `resume`, `remember`, `doctor`, `init`. Every command is recorded as an event with **who** issued it and **from where**.
- Surfaces are thin adapters that translate input into commands:
  - **Plugin** (`/foedrum:<command>`): the engineer's interface. Every command is available here.
  - **Terminal** (`foedrum <command>`): the same commands; the plugin calls it, and scripts and CI can too.
  - **GitHub comments** (`/foedrum <command>` on orders, sub-orders and bottles): for the autonomous driver and for asynchronous teammates.
  - **Dashboard** (M6): shows each batch's live session output (the brewer's event stream that the engine already reads) and its pending questions side by side. Questions appear with their options and recommendation and are answered in place, which issues an `answer` command and so resumes the brewer's session. From the same view, an engineer can retry, rewind or take over.
- Commands that only make sense on one surface are marked as such in the command registry. A **parity test** fails when a command is missing from a surface without being marked.
- **Authorisation** sits in the command layer: GitHub comments from allow-listed users only; the plugin and the terminal for whoever runs them on that machine; the dashboard bound to localhost with a per-session token.
- **Comments** are processed exactly once: the comment's id is the idempotency key. Foedrum acknowledges with a reaction (👀 received, 🚀 done, 😕 rejected with the reason in the status comment) and ignores later edits. Only the command line is parsed; free text reaches brewers as delimited, untrusted data ([ADR 0041](0041-untrusted-input-in-per-prompt-nonce-tags.md)).

## Consequences
- Foedrum is useful from the first interactive release without running a background process; the Cellar adds unattended throughput.
- The engine must be a library with no hidden dependency on running as a daemon, which the event-sourced design already favours.
- The plugin becomes the main human interface and arrives earlier than planned. It still contains Markdown only and calls the `foedrum` program.
- Brewer sessions are persisted for the lifetime of a batch, which uses disk space; cleanup follows the batch.
- Leases and handovers become part of the chaos tests: two drivers, crashes, and expired leases must never produce duplicated side effects.

## Alternatives considered
- **Comments as the only interface:** works asynchronously, but deep conversations become slow and expensive.
- **Plugin requires a running Cellar:** simpler, but forces every engineer to run a daemon before trying Foedrum.
- **Let the session's model decide the next step:** flexible, but breaks the deterministic engine and its guarantees.
- **Separate implementations per surface:** quick at first, but surfaces drift apart; one command layer keeps them identical by construction.
