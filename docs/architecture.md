# Architecture

Status: design (v0.1, October 2026). Decisions are recorded as [ADRs](adr/README.md).

## 1. Purpose

Foedrum turns issues in a control repository (the **Brewery**) into pull requests in other repositories, by running Claude agents (**Brewers**) through user-defined pipelines (**Recipes**). Every step has a typed outcome, a deadline and a visible trace.

### Goals for 1.0

1. Issue → pull request in one or more registered repositories via a chosen recipe.
2. Stability as a measurable property: no batch is ever silently stuck.
3. User-defined brewers and recipes, with good defaults.
4. An evaluation harness that scores models, brewers and recipes on real tasks, including new Claude models as they are released.
5. Runs locally on Windows, macOS and Linux.
6. A codebase a reviewer can read in an afternoon.

### Non-goals for 1.0

Hosted or multi-tenant service · public webhook server (1.0 polls) · trackers and code hosts other than GitHub (the interfaces allow them later, see §3.1) · non-Claude agents · code plugins.

## 2. Concepts

| Concept | Term |
|---|---|
| Control repository | **Brewery** |
| Issue in the Brewery | **Order** |
| Single-repository part of an order (sub-issue) | **Sub-order** |
| Pull request bundling one or more sub-orders | **Bottle** |
| Waiting for a merge or release | **Conditioning** ⏳ |
| Agent role (prompt, inputs, output, model, tools, permissions, budget) | **Brewer** |
| Pipeline: brewers and checks in order, with loops | **Recipe** |
| One execution of a recipe for an order | **Batch** |
| One position in a recipe | **Step** |
| One try at a step | **Attempt** |
| Deterministic check (tests, lint, types, diff limits) | **Gravity reading** |
| AI review | **Tasting** |
| Needs a human | **Stuck** 🔔 |
| Rules learned from reviews | **House yeast** |
| Evaluation suite | **Flight** |

Full list: [glossary](glossary.md).

## 3. System overview

```
             GitHub: Brewery repo                         GitHub: target repos
       issues · labels · comments · PRs                   branches · pull requests
              ▲              │                                    ▲
   projection │              │ poll                               │ push / PR
              │              ▼                                    │
┌──────────────────────────── foedrum serve ─────────────────────────────────────┐
│  Intake ──► Router ──► Scheduler ──► Executor ──► BrewerRunner (claude CLI)    │
│                           ▲   │          │             │                       │
│                           │   ▼          ▼             ▼                       │
│                       Supervisor     Workspace       Checks                    │
│                   (leases, deadlines) (git worktrees) (gravity readings)       │
│                           │                                                    │
│              ┌────────────┴─────────────┐                                      │
│              │ EventStore (node:sqlite) │ ◄── single source of truth           │
│              └────────────┬─────────────┘                                      │
│                           ▼                                                    │
│      Projections: status comment · labels · CLI · (later) live dashboard       │
└────────────────────────────────────────────────────────────────────────────────┘
```

- **One process per Brewery** (`foedrum serve`), the single writer of the event store.
- **Brewers run as `claude` CLI child processes** that the engine spawns and owns: it streams their events live and kills the whole process tree on deadline, stall or cancel ([ADR 0003](adr/0003-drive-the-claude-cli.md)).
- **Polling intake** with conditional requests: works on a laptop with zero infrastructure ([ADR 0008](adr/0008-polling-intake.md)).
- **Always worktrees, never a clone per batch** ([ADR 0012](adr/0012-worktrees-from-local-clones.md)). Per repository, `source` is `local` (default: worktrees from the user's existing clone, in Foedrum's own branch namespace `foedrum/…`, never touching the checked-out branch) or `managed` (one bare partial clone per repository, created once, optionally borrowing objects from a local clone). Worktrees live in a **work root outside the Brewery checkout** (default `~/.foedrum/<brewery>/`, configurable; short on Windows), so a brewer only ever sees the target repository's own instruction files — never anything placed in the Brewery.

### 3.1 Trackers and code hosts

Foedrum separates three roles that GitHub happens to play all at once in 1.0:

| Role | Interface | 1.0 | Later candidates |
|---|---|---|---|
| Where orders come from and where status is shown | `Tracker`: list orders, read comments/commands, post and edit the status comment, set state markers (labels, statuses) | GitHub Issues | Jira, Linear, GitLab Issues |
| Where code lives and pull requests are opened | `CodeHost`: clone, push, open pull request, read review comments | GitHub | GitLab, Bitbucket, Azure DevOps |
| Where configuration lives | the Brewery: any git repository | GitHub | any git host |

The user chooses a tracker and a code host per Brewery (`foedrum.jsonc`), and they may differ (for example Jira orders, GitHub pull requests).

**Design rule: a tracker is intake and projection only.** The event store is the source of truth; Foedrum reads orders and commands from the tracker and writes status back to it, but never synchronises workflow state two ways. Tracker-specific concepts (issue types, workflow transitions, re-parenting, key renames) are mapped at the edge, in the adapter, and never leak into the engine. Two-way tracker synchronisation is the most expensive part of an orchestrator to build and keep correct; this rule keeps adapters small.

### 3.2 Work breakdown: orders, sub-orders and bottles

Enterprise changes usually span several repositories. Cross-repository work is a core capability, not an add-on ([ADR 0013](adr/0013-single-repo-sub-orders-bottles-and-releases.md)).

- **All work items live in the Brewery.** Orders and sub-orders are Brewery issues; Foedrum never creates or edits issues in target repositories.
- **Decomposition.** A decomposition step (Maltster + Brewmaster) splits an order into **sub-orders** — GitHub sub-issues of the order — and records dependencies between them as native "blocked by" links. The breakdown is posted as **READY / NOT READY** and brewing starts after `/foedrum approve` — **approval is on by default**; recipes can switch it off. A breakdown produced interactively with the `/foedrum:refine` plugin (§3.5) counts as approved.
- **One sub-order, one repository.** A sub-order never spans repositories. A brewer *writes* in exactly one repository and may *read* sibling repositories for context.
- **Each sub-order gets its own batch** and recipe; batches are scheduled in dependency order.
- **Bottling: choosing what goes into a pull request.** A **bottle** is a pull request. It bundles one or more finished sub-orders of the same repository: their branches are merged into a bottle branch by plain git (conflicts go to the Blender). Policy per recipe: `"bottling": "perSubOrder" | "perRepo" | "manual"`; manually with `/foedrum bottle #101 #102`. Bottles of the same order reference each other and carry a suggested merge order.
- **Dependency kinds:**

| Kind | Meaning | The dependent batch waits for |
|---|---|---|
| `code` | Builds on another sub-order's code in the same repository | That sub-order's branch (stacked) |
| `release` | Needs a published version of another repository's library | The bottle to be merged, CI to publish, and the **release signal** to report the new version; the dependent batch then starts by bumping the dependency |

- **Release signals** are configured per repository: **GitHub release or tag** first; package registries (NuGet, npm, Maven, …) later through the same interface. Developing against a pre-release build is a later option.

```
Order #100
 ├─ #101  lib-core  add field X
 ├─ #102  lib-core  validate X
 ├─ #103  api       use X          blocked by #101, #102  (release of lib-core)
 └─ #104  web       show X         blocked by #103        (code)

Bottle A  lib-core  #101 + #102 → PR → CI → lib-core 2.4.0
Bottle B  api       #103 → waits for lib-core ≥ 2.4.0 → bump → PR
Bottle C  web       #104 → PR
```

### 3.3 Triage of target-repository issues

Issues filed in target repositories (bug reports, user requests) are a **triage source**, never a work queue. The Infection check recipe reads them — selected by repository and label/filter, by explicit references, or on a schedule — reproduces the problem in a clean worktree, confirms the root cause at file and line, and records the findings as one or more **orders in the Brewery** that link back to the source issue. It stops there: it never fixes, assigns, labels or closes anything in the target repository. Commenting a link back on the source issue is an opt-in setting.

### 3.4 State in the Brewery repository

The Brewery is a git repository, so it also holds Foedrum's durable state ([ADR 0011](adr/0011-state-in-the-brewery-repository.md)):

- On a dedicated **`foedrum/state` branch** (keeping `main` for configuration), each batch has a folder with an append-only `events.jsonl` and its **out docs** (plans, reviews, reports) — readable, reviewable history.
- State is committed at **every step boundary** and pushed. The local SQLite database is an index and working store that `foedrum serve` rebuilds from the state branch on any machine.
- **One active engine per Brewery:** a rejected push means another engine wrote in between; the engine stops instead of diverging.
- **Rewind:** every step records the commit SHA of each repository involved. `/foedrum rewind <step>` resets the batch's branches to those SHAs and appends a "resumed from step" event. History is never rewritten; work continues from an earlier point. An already open bottle is **updated in place**: its branch is force-pushed to the rewound state and a comment on the pull request explains the rewind.
- **No duplicate pull requests after a crash:** branch names are deterministic (`foedrum/<batch>/<repo>`), so Foedrum looks up an existing pull request before creating one, even if the last event never reached the state branch.

### 3.5 Interactive refinement

Good automation starts with a sharp breakdown. Analysis and decomposition are where a human adds the most value, so Foedrum offers them interactively ([ADR 0014](adr/0014-interactive-refinement-plugin.md)):

- A small **Claude Code plugin** provides `/foedrum:refine #<order>`. You run it in your own interactive Claude Code session, investigate the order together with Claude — across the registered repositories, read-only — and steer until the path is obvious.
- When you are satisfied, the plugin writes the result into the Brewery: the analysis as an out doc on the state branch, the sub-orders as sub-issues with dependencies, and a plan per sub-order. The breakdown counts as approved; Foedrum starts brewing.
- Re-running `/foedrum:refine` on an order that already has sub-orders shows the current breakdown and lets you deepen, add or cancel sub-orders (never silently delete).
- The plugin is Markdown commands and skills only — no npm packages — and talks to the Brewery through the `foedrum` CLI.

Since [ADR 0019](adr/0019-interactive-sessions-and-one-command-layer.md), refinement is one of several interactive steps (refine, triage, review) that run in the engineer's session, with or without the Cellar running.

### 3.6 Delivery

Foedrum ships as an npm command-line program with a companion Claude Code plugin ([ADR 0016](adr/0016-delivery-npm-cli-and-companion-plugin.md)):

| Part | What it is | How users get it |
|---|---|---|
| `foedrum` CLI | The engine (`foedrum serve`), `init`, `doctor`, `status`, `stuck`, `replay`, and the default brewers, recipes and lenses | `npm install --global foedrum` or `npx foedrum`, published with provenance |
| Claude Code plugin | Interactive commands (`/foedrum:refine`); Markdown only, calls the CLI | `/plugin marketplace add EdwinBekaert/foedrum` |
| Brewery | The user's control repository | `foedrum init` |
| Brewhouse (M6) | Dashboard served by the engine | `foedrum serve` prints its local address |

The engine runs in a terminal or as a service the user sets up (documented for systemd, launchd and Task Scheduler); it never depends on an open Claude Code session.

## 4. Data model

### 4.1 Events

State is derived from an append-only event log ([ADR 0002](adr/0002-event-sourced-engine-on-node-sqlite.md)).

```ts
type Event =
  | { type: 'batch.ordered';       batchId: string; order: OrderRef; parentBatchId?: string }
  | { type: 'batch.recipe_chosen'; batchId: string; recipe: string; reason: string; by: 'label' | 'router' | 'human' }
  | { type: 'step.scheduled';      batchId: string; stepId: string; attempt: number; deadlineAt: string }
  | { type: 'step.started';        batchId: string; stepId: string; attempt: number; session?: SessionRef }  // required for brewer and session steps
  // SessionRef = { id: string; resumes?: string; worktree: string; claudeVersion: string }
  | { type: 'step.finished';       batchId: string; stepId: string; attempt: number; outcome: StepOutcome; usage?: Usage }
  | { type: 'input.received';      batchId: string; stepId: string; by: string; via: Surface; answers: Answer[] }
  | { type: 'batch.stuck';         batchId: string; reason: StuckReason; options: StuckOption[] }
  | { type: 'batch.resumed';       batchId: string; by: string; via: Surface; action: 'retry' | 'skip' | 'recipe' | 'answer' }
  | { type: 'order.decomposed';    batchId: string; subOrders: SubOrderRef[]; dependencies: Dependency[] }
  | { type: 'batch.waiting';       batchId: string; on: WaitCondition; remindAt: string }   // merge, release, sibling batch
  | { type: 'bottle.opened';       bottleId: string; repo: string; subOrders: number[]; pullRequest: string }
  | { type: 'release.observed';    repo: string; package: string; version: string }
  | { type: 'batch.rewound';       batchId: string; toStepId: string; by: string; shas: Record<string, string> }
  | { type: 'batch.on_tap';        batchId: string; pullRequests: string[] }
  | { type: 'batch.cancelled';     batchId: string; by: string }
  | { type: 'effect.applied';      key: string; result: unknown }   // idempotency ledger for external side effects
```

`Surface` is `plugin`, `terminal`, `comment` or `dashboard`. Session ids are part of the state, so any action can resume the right session ([ADR 0019](adr/0019-interactive-sessions-and-one-command-layer.md)).

```ts
type OrderRef    = { issue: number }                                   // a Brewery issue
type SubOrderRef = { issue: number; repo: string }                     // repo is owner/name; one repository per sub-order
type Dependency  = { subOrder: number; blockedBy: number; kind: 'code' | 'release' }
type Usage       = { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }
type Answer      = { q: string; answer: string }
type StuckOption = 'answer' | 'retry' | 'skip' | 'recipe' | 'rewind' | 'cancel'
type StuckReason =
  | { kind: 'needs_input';         stepId: string; questions: Question[] }
  | { kind: 'blocked';             stepId: string; blockerKind: BlockerKind; summary: string }
  | { kind: 'attempts_exhausted';  stepId: string; attempts: number; lastReason: string }
  | { kind: 'deadline_passed';     stepId: string; deadlineAt: string }
  | { kind: 'waiting_for_session'; stepId: string }
type WaitCondition =
  | { kind: 'merge';   pullRequest: string }
  | { kind: 'release'; repo: string; package: string; minVersion: string }
  | { kind: 'sibling'; batchId: string }
```

The zod schemas in `src/schemas/` are the source of these types. Every object is strict (unknown fields are rejected), timestamps are ISO 8601 in UTC, pull requests are `https` URLs without credentials, shas are full commit hashes, an effect key is the canonical JSON text `["batchId","stepId",attempt,"effect"]` exactly as `JSON.stringify` writes it, and a breakdown's dependencies may only name its own sub-orders and never form a cycle.

Leases live in a separate mutable table (`attempt_key, owner, expires_at`; a lease covers the attempt's session as well): they are renewed every few seconds and only matter while alive.

The `EventStore` interface (`src/engine/event-store.ts`) hides the storage; its implementation on `node:sqlite` keeps four tables under a schema version (`PRAGMA user_version`) with a migration per version: `events`, append-only through triggers; `leases`; and two indexes of the events, maintained on append, so `replay` rebuilds them from a log (ADR 0011):

- `effects`: the idempotency ledger is the `effect.applied` events. Recording an effect appends one, keyed by the canonical JSON array `[batch, step, attempt, effect]` (`src/engine/effect-key.ts`), and the index holds each key once. A trigger on `events` fills it, so the database itself refuses a second event for a key (the failed insert leaves no row), and `replay` refuses a log that contains one.
- `deadlines`: the pending deadline of each step of a batch, so "batches past their deadline" is one indexed query (a batch's earliest). `step.scheduled` sets its step's deadline and ends a Conditioning reminder; `batch.waiting` sets the reminder; `step.finished` clears its own attempt's deadline; `batch.stuck`, `batch.on_tap` and `batch.cancelled` clear every deadline of the batch.

Events are validated against the zod schemas when appended and when read. All writes go through `withTransaction` (`BEGIN IMMEDIATE`; rolled back on any throw; not nestable), in WAL mode with a busy timeout. The store reads no clock: callers pass `now`.

Current state is a pure fold over events (`src/engine/fold.ts`): orders and sub-orders (one repository each) with their dependencies, batches with their lane, steps, attempts, rewinds, bottles, observed releases and the idempotency ledger. An issue is in at most one of `orders` and `subOrders`, and every batch is listed on exactly one of them. Breakdowns have one level (§3.2): only an order is decomposed. Several sub-orders of one order may target the same repository; the fold orders nothing among them beyond the recorded dependencies. A new breakdown replaces the order's sub-order list and dependencies; the sub-orders it leaves out are marked `cancelled`, never deleted, and keep their batches, and a later breakdown that lists one again un-cancels it.

The fold records what the events say and leaves the batch lifecycle to the state machine; it only requires attempts to go from scheduled to started to finished. It throws an `InvalidLogError`, naming the index and type of the event and the reason, when an event:

- refers to a batch, step or attempt the log never created, repeats one, or takes an attempt out of that order;
- opens a bottle or applies an effect twice (invariant I4);
- decomposes a sub-order, lists an order as a sub-order, or moves a sub-order to another order.

Such a log is corrupt. The command layer refuses these events before they are appended; the fold's check is the last line of defence. Crash recovery is replay.

### 4.2 Step outcome — the single contract

```ts
type StepOutcome =
  | { kind: 'succeeded';   output: unknown }
  | { kind: 'failed';      retryable: boolean; reason: string }
  | { kind: 'needs_input'; questions: Question[] }
  | { kind: 'cancelled' }
```

Every step kind (brewer, check, human gate, action, fan-out) ends in exactly one of these. An exhaustive `switch` makes an unhandled outcome a compile error ([ADR 0005](adr/0005-typed-step-outcomes-and-out-docs.md)).

### 4.3 Batch lifecycle

```
            ┌──────────── conditioning ◄──┐   (waiting for a merge, a release or a sibling)
            ▼                             │
ordered ──► brewing ──────────────────► on_tap
              │  ▲
              ▼  │  /foedrum retry · answer · skip · recipe · rewind
             stuck ──► cancelled
```

Board lanes are these states: **Ordered · Brewing · Conditioning ⏳ · Stuck 🔔 · On tap**. Conditioning is waiting with a visible reason ("waiting for lib-core ≥ 2.4.0") and a reminder (default: after 2 days, then every 2 days; configurable per Brewery and recipe) — never silent, but not a failure either.

### 4.4 Invariants

Property-tested (see §9):

- **I1** Every non-terminal batch has exactly one pending action with a deadline (for conditioning batches: a reminder deadline).
- **I2** At most one live lease per attempt and per worktree.
- **I3** Replaying the log yields identical state.
- **I4** Every external side effect is keyed `(batch, step, attempt, effect)` and applied at most once.
- **I5** A batch past its deadline becomes `stuck` within one supervisor tick.
- **I6** From every reachable state, a terminal state is reachable.

## 5. Failure modes designed out

Agent orchestrators typically get stuck in a handful of ways. Foedrum removes each class structurally instead of patching instances.

| Failure class | Typical symptoms | Mechanism |
|---|---|---|
| **Agent process observed from outside** | orphaned sessions, "alive but idle" processes, sessions outliving the orchestrator, spawn errors | The engine spawns and owns the child process, reads its stream live, renews a lease while it runs, and kills the process tree on deadline/stall/cancel. On restart, recorded process trees are killed — there is no "maybe alive" state |
| **"Done" inferred from side effects** | agent exits 0 without doing work, missing report, unread messages | A brewer is done only when it writes a valid **out doc** (JSON frontmatter validated by schema). "No changes needed" is an explicit value, never an absence. Deterministic guards check commits, removed tests, scope |
| **State spread over many stores** | reconcile/orphan/stale fixes, drift between files | One event log (durable on the Brewery's state branch, indexed locally in SQLite); everything else is a projection |
| **Agents asking humans mid-run** | sessions parked on a question, resume failures | Brewers never ask mid-run. A question is an outcome (`needs_input`); the answer starts the next attempt ([ADR 0006](adr/0006-no-mid-run-questions.md)) |
| **Unbounded loops** | "another round?" decisions, review/fix cycles that never converge | Every loop has `max_rounds`; exhaustion → Stuck with explicit options |
| **Shared working trees** | two sessions in one checkout, merge collisions | One worktree per attempt, protected by a lease |
| **Environment problems disguised as task failures** | agents retrying an unbuildable environment, flailing on denied tools | Out docs carry `blocker_kind: environment`; repeated permission denials abort the attempt and name the missing tools → Stuck, not retry |
| **Duplicate side effects after a crash** | two pull requests, double comments | Idempotency ledger (I4) enforced by a `UNIQUE` constraint |

The remaining risk is honest: brewers are still external processes. Deadlines, stall detection and leases are therefore mandatory — as one generic mechanism instead of many special cases.

## 6. Brewers and recipes

Brewers are defined first, then composed into recipes. Full specification: [brewers-and-recipes.md](brewers-and-recipes.md).

- A **brewer** is a Markdown file with JSON frontmatter (read as JSONC, [ADR 0020](adr/0020-jsonc-frontmatter.md)): inputs (in-docs), output (out doc + schema), model, effort, tools, permissions, workspace, budget, retries and guards. The body is the prompt.
- A **recipe** is a JSONC file: an ordered list of steps — brewers, gravity readings, human gates, actions (open PR, comment, blend) and fan-out — with loops (`max_rounds`, `until`).
- **Test-first by structure:** recipes with `testFirst` run the Gauger (failing tests), a red proof (a gravity reading with `"expect": "fail"`, read from the repository's structured test report), then Cellarman, whose `testsUnchanged` guard protects the red tests' assertions ([ADR 0017](adr/0017-test-first-recipes-and-tasting-lenses.md)).
- **Tasting through lenses:** the Taster reviews through one lens per session (correctness, security, cross-platform, design conformance, test design; [ADR 0022](adr/0022-five-default-lenses.md)) in a parallel group. Brett proposes mutants; the engine confirms which ones the tests miss, and these findings are advisory by default.
- **Routing:** a `recipe:<name>` label wins; otherwise a lean router call picks one and explains why; a human can override before work starts.

### Default recipes

| Recipe | Use |
|---|---|
| Nip | quick fix |
| Half-pint | small feature |
| Pint | medium feature, with plan approval |
| Growler | large feature: decomposed into single-repository sub-orders, bottled per repository |
| Keg | multi-repository change with release dependencies between repositories |
| Pilot batch | spike / research, no PR |
| Infection check | triage of target-repository issues: reproduce, root cause, findings as Brewery orders (§3.3) |
| Guest tasting | review someone else's pull request |
| Re-pitch | re-review a pull request after fixes |
| Refresh | dependency upgrades (scheduled) |

## 7. Token economy

Orchestration should cost (almost) nothing:

- The engine is plain code: advancing, routing by label, loops, checks, git and GitHub use **zero model tokens**.
- The only text Foedrum adds to a brewer prompt is a short contract (~300 tokens) describing the out doc.
- Brewers run with a **lean context** by default (no project instructions, hooks, plugins or MCP unless the brewer declares them).
- Brewers receive the previous step's out doc, never full histories or transcripts.
- Prompts are ordered static-first for prompt-cache reuse; effort stays constant per brewer.
- Every attempt records tokens; Foedrum reports **orchestration overhead** (router + contract tokens ÷ total). Target: below 5 %.

## 8. Humans in the loop

Foedrum has two **drivers** that share one deterministic engine library and one event store ([ADR 0019](adr/0019-interactive-sessions-and-one-command-layer.md)):

- **Interactive:** an engineer opens Claude Code and types a plugin command, for example `/foedrum:brew 21`. The session drives the batch, without `foedrum serve` running: it asks the engine for the next step, runs it, shows progress live, and asks the engineer right away when a brewer returns `needs_input`. Judgement-heavy steps (refine, triage, review) run in the session itself.
- **Autonomous:** the Cellar (`foedrum serve`) picks up orders and commands from GitHub, and later from the Brewhouse dashboard.

A batch has one driver at a time, held as a lease with a heartbeat; taking over is an explicit, recorded command, and an expired lease frees the batch. `/foedrum:resume <batch> [<step>]` steps into any brewer's own session (`claude --resume`) in its worktree.

**One command layer.** Every action (`brew`, `status`, `stuck`, `answer`, `approve`, `retry`, `skip`, `rewind`, `cancel`, `pause`, `bottle`, `recipe`, `refine`, `triage`, `review`, `resume`, `remember`, `doctor`, `init`) is one typed command, recorded as an event with who issued it and from where. The plugin (`/foedrum:<command>`), the terminal (`foedrum <command>`), GitHub comments (`/foedrum <command>`) and later the dashboard are thin adapters; a parity test keeps them identical. The dashboard shows each batch's live session output next to its pending questions, which are answered in place.

On GitHub, for the autonomous driver and asynchronous teammates:

- One **status comment** per order, edited in place: recipe (as a Mermaid diagram with the current step highlighted), steps, state, assumptions brewers made, cost.
- A **GitHub Projects board** with one column per lane serves as the kanban view until the Brewhouse dashboard (M6).
- **Labels** mirror lanes: `foedrum:brewing`, `foedrum:stuck`, `foedrum:on-tap`.
- **Commands** in comments, from allow-listed users only, processed exactly once (the comment id is the idempotency key) and acknowledged with a reaction: 👀 received, 🚀 done, 😕 rejected with the reason in the status comment.

## 9. Testing strategy

Stability is proven, not claimed.

1. **Unit tests** (`node:test`) for the fold, state machine, recipe parsing, GitHub client (injected `fetch`). They start no processes: git, npm and other tools are reached through an injected process runner, and `npm run check` stays under 20 s ([ADR 0021](adr/0021-unit-tests-spawn-no-processes.md)). **Integration tests** (`test/integration/`, `npm run test:integration`, CI and nightly) are a few per tool boundary, running the real git, npm or shell to prove the thin shells and the captured fixtures still match the real tools.
2. **Fake brewer runner** with scripted behaviours: succeed, fail, hang, garbage output, no output, exceed budget, crash mid-step, ask a question.
3. **Property tests** on the state machine: random event sequences must keep invariants I1–I6. A seeded generator (`test/helpers/event-sequences.ts`, no dependency) writes the sequences; each run starts from a fresh seed, a failure names it, and setting the environment variable `FOEDRUM_SEED` to that seed replays it.
4. **Chaos tests:** run many batches with the fake runner, kill the engine at random points, restart, and assert every batch reaches a terminal or Stuck state with no duplicated side effect.
5. **Contract tests** against a real GitHub test repository (opt-in, CI only).
6. **End-to-end tests** (from M1): a real test Brewery and target repository on GitHub, driven by the fake brewer runner — issue → batch → pull request, fast and deterministic. A **nightly smoke test** uses the real `claude` CLI to catch changes in its stream format.
7. **Browser end-to-end tests** (from M6, when the dashboard exists): Playwright Test as a development dependency, subject to the admission checklist; browsers are downloaded by an explicit command, not an install script.
8. **Cross-platform:** every test layer runs on Windows, macOS and Linux in CI (§13).
9. **Evaluations** (§11) measure agent quality, separately from correctness tests.

Foedrum's own code is written test-first, with the red commit before the implementation commit, and every pull request goes through a review skill that applies the same red proof, lenses and mutation check Foedrum ships ([ADR 0017](adr/0017-test-first-recipes-and-tasting-lenses.md)). CI enforces coverage thresholds with Node's built-in coverage.

Browser testing *in target repositories* is a recipe concern, not a Foedrum test: a gravity reading can run the repository's own end-to-end suite (`"check": ["test", "npx playwright test"]`), and a verification brewer (Lab tech) can use a browser tool to exercise a UI change and attach screenshots to the pull request (M6).

Published metrics: chaos runs passed, stuck-without-transition count (target 0), orchestration overhead, evaluation scores per model.

## 10. Security model

| Threat | Mitigation |
|---|---|
| Prompt injection through issue or PR text | Only allow-listed authors create orders and commands; untrusted text is delimited and marked as data; brewers have tool allowlists; `AskUserQuestion` and pushing are always denied |
| Agents running malicious install scripts in target repos | Brewer environment forces `npm_config_ignore_scripts=true`; sandbox by default, container optional |
| Repository-controlled agent settings or hooks | Lean context ignores project settings unless the brewer opts in |
| Secret leakage | Minimal environment per brewer; short-lived, repository-scoped tokens; orchestrator credentials never passed to brewers |
| Foedrum's own dependencies | [Dependency policy](../DEPENDENCIES.md) ([ADR 0004](adr/0004-built-in-first-dependency-policy.md)) |
| Brewers acting outside their worktree | Generated per-attempt settings deny file tools outside the worktree; OS sandbox where available (§13); `scope` guard after every attempt |
| Windows process spawning | Every CLI argument validated against a strict pattern; prompts and settings passed via stdin and files, never as arguments |

**Authentication:** Claude — whatever the user's `claude` CLI is logged in with. GitHub — a fine-grained personal access token in 1.0, a GitHub App later.

## 11. Evaluation: Flight and blind tasting

- A public **tasting room** repository with seeded issues per recipe and **hidden acceptance tests** brewers never see; planted bugs for Infection check; pull requests with planted defects for Guest tasting.
- **Real batches become samples:** any batch that got stuck or needed human fixes can be exported into the Flight.
- **Metrics per recipe × brewer × model:** hidden-test pass rate, first-attempt gravity pass rate, retries, stuck rate, tokens, duration, diff size, planted-defect recall.
- **Blind tasting:** `foedrum taste --model <id> [--brewer <name>]` swaps one brewer's model, runs the Flight several times (agent runs are noisy) and compares with the baseline.
- **Model watcher:** when Anthropic lists a new model, Foedrum runs blind tasting per brewer and opens a pull request on the Brewery that updates `models.jsonc`, with the report as its description.
- The same harness gates changes to Foedrum's own default brewers and recipes.

## 12. Extensibility

1. **Files in the Brewery** — add or override brewers and recipes by committing files; review and evaluate them like code.
2. **Packs** (later) — declarative bundles of brewers, recipes and checks; no code. Installed from a git repository pinned to a commit SHA, with a checksum and a **permission ceiling** set by the Brewery. Every pack ships evaluation samples.
3. **Visual** — recipes rendered as Mermaid early; a drag-and-drop recipe editor in the dashboard later, saving as a pull request to the Brewery.

## 12b. House yeast: the learning flywheel

Reviews produce lessons ("never swallow errors in this module", "use the shared retry helper"). Kept as one ever-growing rules file and read in full by every agent, such a flywheel quickly reaches tens of thousands of tokens per run, and adherence drops as the list grows. House yeast is designed to stay small, relevant and enforceable ([ADR 0015](adr/0015-house-yeast.md)):

1. **Rules carry metadata:** scope (repository, file globs, language, optionally a tasting lens), kind (structural or semantic), source (the review that produced it), date, and counters for how often it was selected and violated.
2. **Selected per attempt, within a budget:** a brewer receives only rules whose scope matches the repository and files it works on (and, for a Taster, its lens), ordered by relevance and recency, within a token budget (default about 2,000 tokens). Never the whole collection.
3. **Promoted to gravity readings:** a rule that can be checked mechanically (a lint rule, a search pattern, a test) becomes a deterministic check — enforced every time at zero tokens — and leaves the prompt.
4. **Curated:** a periodic curation step merges duplicates, folds similar rules together and retires rules that have not been relevant for a long time. Curation changes arrive as pull requests to the Brewery.
5. **Suppressions are scoped too:** "do not flag this again here" applies to the reviewing brewer and to the matching scope only.

**Three layers** ([ADR 0018](adr/0018-house-yeast-layers.md)):

| Layer | Location | Holds | Approved by |
|---|---|---|---|
| Defaults | Shipped with Foedrum, mostly inside lens and brewer prompts | Craft rules that hold everywhere | Foedrum maintainers, measured with the Flight |
| Brewery | `house-yeast/` in the Brewery | Conventions across the organisation's repositories | Brewery owners, by pull request |
| Repository | `.foedrum/house-yeast/` in the target repository | Knowledge about that repository's code | The repository's owners, in the bottle that introduces the rule |

Selection draws from all layers within one budget; the more specific layer wins. Repository rules are untrusted input, read only from registered repositories. A repository can opt for the Brewery fallback (`houseYeast: "brewery"`), and nothing flows back to Foedrum's defaults automatically.

**From lesson to rule:** a review finding that needed a fix, or a human review comment on a bottle, is recorded as a **candidate** on the state branch. When the lesson recurs, or a human asks with `/foedrum remember`, it is proposed as a rule: one Markdown file with JSON frontmatter. A repository-layer rule ships in the same bottle as the fix that taught it. A human always approves a rule.

## 13. Platform support and isolation

Foedrum runs on **Windows, macOS and Linux** ([ADR 0010](adr/0010-cross-platform-and-isolation-levels.md)).

### Isolation levels

Claude Code's OS sandbox covers **shell commands only** and is available on macOS (Seatbelt), Linux and WSL2 (bubblewrap + socat); on native Windows, shell commands run unsandboxed. File tools, MCP servers and hooks are governed by permission rules on every platform.

| Level | Where | What Foedrum does |
|---|---|---|
| **Sandboxed** | macOS, Linux, WSL2 | Per-attempt settings enable `sandbox.enabled` with `allowUnsandboxedCommands: false`, writable paths limited to the worktree, network limited to an allowlist |
| **Permissions only** | Native Windows | Strict tool allowlists, file-tool deny rules outside the worktree, minimal environment, `scope` guard. A warning is shown at start |
| **Container** (optional, any OS with an OCI container runtime: Podman or Docker) | Anywhere | The brewer runner starts `claude` inside a container that mounts only the worktree |

- `foedrum doctor` reports the effective isolation level and missing prerequisites (for example `bubblewrap`).
- A Brewery can require a minimum level (`"isolation": { "minimum": "sandboxed" }`); writing brewers then refuse to run below it. Read-only brewers may run at a lower level.
- Recommended setup on Windows for untrusted repositories: run Foedrum inside WSL2.

### Cross-platform rules for the code

| Area | Rule |
|---|---|
| CI | Every pull request, push to `main` and nightly run uses `ubuntu-latest`, `macos-latest` and `windows-latest`, on Node 24 and the current LTS. `npm test` fails below the coverage thresholds (Node's built-in coverage, still experimental). The single required check is `ci-ok` |
| Paths | Only `node:path`, `os.homedir()`, `os.tmpdir()`; never string-built paths or `~`. Comparisons respect case-insensitive file systems (Windows, macOS) |
| Path length | Short batch ids and worktree paths; `core.longpaths=true` in Foedrum-managed clones on Windows |
| Spawning `claude` | On Windows only possible through a shell: every argument validated against a strict pattern; prompts and settings via stdin and files |
| Spawning git and checks | `execFile` with argument arrays (no shell) for git; check commands run through the platform shell with optional per-OS overrides (`{ "run": "…", "windows": "…" }`) |
| Killing process trees | POSIX: process groups (`detached` + negative pid); Windows: `taskkill /T /F /PID` |
| Signals | No reliance on `SIGTERM` on Windows; graceful shutdown on `SIGINT` and an explicit stop command |
| Line endings | `.gitattributes` with `eol=lf` in Foedrum; frontmatter parsing tolerates CRLF; a guard fails attempts whose diff is mostly line-ending churn |
| File locks | File and folder removal through `src/platform/remove.ts`: read-only bits (the Windows ReadOnly attribute) cleared first, `EBUSY`/`EPERM`/`ENOTEMPTY` retried with a short backoff; stale `index.lock` cleanup after interrupted git commands |
| Executables | Resolve `claude` and `git` via `PATH` and `PATHEXT` on Windows; `foedrum doctor` shows the resolved paths |

## 14. Layout

**Foedrum repository:**

```
src/
  cli/          entry point and commands
  engine/       events, fold, store, scheduler, supervisor, executor
  brewers/      brewer loading, prompt rendering, CLI invocation
  recipes/      schema and loading
  github/       client, auth, intake, projection
  workspace/    git and worktrees
  platform/     OS differences: removal, path comparison, process trees (§13)
  checks/       gravity readings
  evals/        flight, blind tasting, model watcher
  schemas/      zod schemas (source of types, validation and JSON Schema)
  formats/      JSONC and frontmatter readers (limits for untrusted input: 64 levels, 1 MiB; ADR 0020)
schemas/        JSON Schema files generated from src/schemas (npm run schemas)
defaults/       default brewers, recipes and tasting lenses
plugin/         companion Claude Code plugin (Markdown commands and skills)
test/           unit, property, chaos
docs/
```

**A Brewery:**

```
foedrum.jsonc     repositories (source, release signal, triage sources, check commands, test report, setup, toolchain allowlist; ADR 0023), allow-listed users, concurrency, budgets, permission ceiling
models.jsonc      model per brewer (updated by blind-tasting pull requests)
brewers/          custom and overriding brewers (*.md)
recipes/          custom and overriding recipes (*.jsonc)
house-yeast/      Brewery-layer rules, and repository-layer rules for repositories with the Brewery fallback (§12b)
.foedrum/         local (git-ignored): SQLite index, logs

Work root (outside the checkout, default ~/.foedrum/<brewery>/): worktrees, managed clones

Branch foedrum/state: batches/<id>/events.jsonl and out docs, committed at every step boundary
```

**A target repository** receives only what its bottles bring, plus:

```
.foedrum/house-yeast/   repository-layer rules (one Markdown file per rule), committed in bottles (§12b)
```
