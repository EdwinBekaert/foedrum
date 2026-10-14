# Brewers and recipes

Status: design (v0.1). A **brewer** is a reusable agent role. A **recipe** puts brewers, checks and actions in order, with loops. Brewers are defined first; recipes compose them.

## 1. Brewer

A brewer is a Markdown file (`brewers/<name>.md`) with JSON frontmatter. The body is the prompt.

### 1.1 Fields

**Identity**

| Field | Purpose |
|---|---|
| `name` | Unique id, referenced by recipes |
| `description` | When to use this brewer; read by the router and shown in docs |
| `version` | Bumped on change; changes are evaluated before adoption |

**Prompt**

| Field | Purpose |
|---|---|
| body | Instructions with `{variables}` |
| `doneWhen` | Explicit definition of done |

**Inputs (in-docs)**

| Field | Purpose |
|---|---|
| `inputs[]` | Named documents: the order, an earlier step's out doc, repository files |
| `inputs[].trusted` | Untrusted input is wrapped in delimiters and marked as data, never instructions |
| `houseYeast` | Receive learned rules from all three layers (defaults, Brewery, repository), selected by scope within a token budget (architecture §12b) |
| `toolbox` | A short brief of extra command-line tools this brewer may use |

**Output (out doc)**

| Field | Purpose |
|---|---|
| `output.doc` | File the brewer must write |
| `output.schema` | Named schema for the frontmatter (validated) |
| `produces` | Expected side effects: `commits`, `report`, `comment`, `none` |

**Model**

| Field | Purpose |
|---|---|
| `model` | Alias resolved through `models.jsonc`, so evaluations can swap it |
| `effort` | Reasoning effort; constant across retries to keep the prompt cache valid |

**Tools and context**

| Field | Purpose |
|---|---|
| `tools.allow` | Allowlist, including scoped shell commands (`Bash(npm test*)`) |
| `tools.deny` | Denylist; `AskUserQuestion` and `git push` are always denied |
| `skills`, `mcp` | Claude Code skills, plugins or MCP servers this brewer may use (default: none) |
| `context` | `lean` (default: no project instructions, hooks, plugins or MCP) or `repo` (load the target repository's instructions) |

**Permissions and workspace**

| Field | Purpose |
|---|---|
| `access` | `read` or `write` |
| `tree` | `task` worktree, `integration` tree, a fresh read-only checkout, or a disposable `scratch` tree that is discarded after the attempt |
| `git` | `commit: true/false`; pushing is always the engine's job |
| `setup` | Repository setup command, run once per worktree, with a timeout |
| `env` | Extra environment variables on top of a minimal base |

Headless brewers always run in a permission mode where the allowlist decides and nothing waits for an approver.

**Budget, watchdog and retries**

| Field | Purpose |
|---|---|
| `deadline` | Wall-clock limit per attempt |
| `maxTurns` | Turn limit |
| `stall` | No file write or commit for N turns or M minutes → abort |
| `maxAttempts` | Attempts before the batch becomes Stuck |
| `retryMode` | `resume` (same session) or `fresh` (new session with the same in-docs) |
| `maxDenials` | Permission denials per attempt before aborting with `blocker_kind: environment` |

**Guards** — deterministic post-conditions checked by the engine

| Guard | Fails when |
|---|---|
| `requiresOutDoc` | the out doc is missing or invalid |
| `requiresCommits` | a writing brewer committed nothing (unless the out doc says no change was needed) |
| `testsNotRemoved` | test declarations disappeared compared with the attempt's start commit |
| `testsUnchanged` | test declarations or assertions committed by the step named in the red proof's `of` were changed or removed (helpers, fixtures, imports and new tests may change) |
| `noPush` | the branch moved on the remote |
| `scope` | files outside the worktree were touched |
| `diffLimits` | more files or lines changed than allowed |

### 1.2 Example

```markdown
---
{
  "name": "cellarman",
  "description": "Makes the Gauger's failing tests pass in one repository.",
  "version": 1,
  "model": "builder",
  "effort": "high",
  "inputs": [
    { "name": "order", "from": "order", "trusted": false },
    { "name": "plan", "from": "step:plan" },
    { "name": "tests", "from": "step:gauge" }
  ],
  "houseYeast": true,
  "output": { "doc": "brew-report.md", "schema": "brewReport" },
  "produces": "commits",
  "context": "repo",
  "tools": {
    "allow": ["Read", "Edit", "Write", "Grep", "Glob", "Bash(npm test*)", "Bash(git add*)", "Bash(git commit*)", "Bash(git diff*)"],
    "deny": ["AskUserQuestion", "Bash(git push*)", "WebFetch"]
  },
  "access": "write",
  "tree": "task",
  "git": { "commit": true },
  "deadline": "30m",
  "maxTurns": 120,
  "stall": { "turns": 60, "minutes": 20 },
  "maxAttempts": 2,
  "retryMode": "fresh",
  "guards": ["requiresOutDoc", "requiresCommits", "testsNotRemoved", "testsUnchanged", "noPush", "scope"]
}
---
Implement the plan in {plan} for the order below. The Gauger's failing tests in {tests}
are the specification: make them pass without changing them. If a test is wrong,
report it as a finding instead of editing it.

Done when: every plan step is done, the Gauger's tests and the full test suite pass,
and everything is committed.
```

## 2. The out doc contract

The only text Foedrum adds to every brewer prompt:

```markdown
When you finish, write {outDoc}. It must start with JSON frontmatter:

---
{
  "status": "done | needs_input | blocked | failed",
  "summary": "<one line>",
  "assumptions": ["<decisions you took without asking>"],
  "questions": [{ "q": "...", "options": ["a", "b"], "recommended": "a", "whyBlocking": "..." }],
  "blockerKind": "findings | environment | divergence"
}
---

Prefer deciding and recording an assumption over asking. Ask only when a wrong
guess would likely waste this run. Never ask questions any other way. Do not push.
```

`questions` is only present with `needs_input`; `blockerKind` only with `blocked`. Brewer-specific fields (for example a review verdict) are added by the brewer's own schema.

### How the engine routes an out doc

| Out doc | Next |
|---|---|
| `done` | Guards pass → next step |
| `needs_input` | Stuck 🔔 with the questions; the answer, from any surface, resumes the brewer's session as the next attempt (fallback: a fresh attempt with a `qa.md` in-doc when the session cannot be resumed) |
| `blocked` + `findings` | Next loop round, until `maxRounds`; outside a loop, the step's `onBlocked` route, else Stuck |
| `blocked` + `environment` | Stuck immediately: another round would hit the same wall |
| `blocked` + `divergence` | Stuck: the plan does not match reality |
| `failed` / missing / invalid | Retry per `maxAttempts`, then Stuck |

## 3. Recipe

A recipe is a JSONC file (`recipes/<name>.jsonc`) with a `$schema` reference for editor autocompletion.

```jsonc
{
  "$schema": "../.foedrum/schemas/recipe.json",          // written by `foedrum init`
  "name": "enkel",
  "description": "Small feature in one repository",
  "match": { "labels": ["feature"] },
  "budget": { "minutes": 60 },
  "testFirst": true,                                         // the router may switch it off, with a reason
  "steps": [
    { "id": "plan", "brewer": "brewmaster" },                // writes plan.md
    { "id": "gauge", "brewer": "gauger",                     // failing tests (+ stubs) + commit
      "when": "recipe.testFirst" },
    { "id": "red", "check": "test", "expect": "fail",        // red proof: gauge's tests fail (behaviour missing)
      "of": "gauge", "when": "recipe.testFirst",
      "onFail": { "goto": "gauge", "maxRounds": 1 } },
    { "id": "implement", "brewer": "cellarman",              // code + commits
      "onBlocked": { "findings": { "goto": "gauge", "maxRounds": 1 } } },  // "this test is wrong"
    { "id": "green", "check": ["typecheck", "lint", "test"], // gravity reading, no model tokens
      "onFail": { "goto": "implement", "maxRounds": 2 } },
    { "id": "review", "loop": {                              // review/fix loop
        "maxRounds": 2,
        "until": "tasting.verdict == 'approve'",
        "steps": [
          { "id": "tasting", "parallel": [                   // approve = every verdict approves
              { "id": "correctness", "brewer": "taster", "lens": "correctness" },
              { "id": "security", "brewer": "taster", "lens": "security" },
              { "id": "mutants", "brewer": "brett" }         // advisory unless "blocking": true
          ] },
          { "id": "fix", "brewer": "cooper", "when": "tasting.verdict != 'approve'" },
          { "id": "recheck", "check": ["typecheck", "lint", "test"],  // the Cooper's commits are measured too
            "when": "tasting.verdict != 'approve'",
            "onFail": { "goto": "fix", "maxRounds": 2 } }
        ]
      },
      "onExhausted": "stuck" },
    { "action": "openPullRequest" }
  ]
}
```

**Step kinds:** `brewer` · `session` (an interactive step that runs in an engineer's Claude Code session: `refine`, `triage` or `review`; under the autonomous driver it waits visibly in the Stuck lane, with a reminder, a deadline and an optional automated fallback) · `check` (gravity reading: a shell command or a built-in check) · `parallel` (a group of steps run side by side; none of them writes the task tree) · `loop` · `gate: "human"` (approval with a deadline) · `action` (`openPullRequest`, `comment`, `label`, `blend`) · `fanOut` (child orders per repository, scheduled as a dependency graph).

**Recipe fields:** `name`, `description`, `match`, `budget`, `steps`, and `testFirst` (default `true` for recipes that write code; the router may switch it off for documentation-only or pure refactoring orders and records why in the status comment).

**Step fields**

| Field | Purpose |
|---|---|
| `id` | Unique step id within the recipe. Expressions (`tasting.verdict`), `goto`, `of` and `from: "step:<id>"` refer to it. Defaults to the brewer name when that is unique |
| `when` | Run the step only when the expression is true; otherwise it is skipped and recorded as skipped. Expressions read step results by id (`tasting.verdict`, `mutants.survivors`) and the recipe's settings after routing (`recipe.testFirst`) |
| `lens` | Taster only: the lens file (`lenses/<lens>.md`) that sets the review focus |
| `expect` | `check` only: `"pass"` (default) or `"fail"`. `"fail"` is a **red proof** |
| `of` | Red proof only: the step whose committed tests must fail because the behaviour is missing (a failed assertion or an error thrown by the code under test); load, compile, import or collection errors do not count |
| `blocking` | Brett only: `true` makes confirmed surviving mutants block the tasting verdict (default `false`, advisory) |
| `onFail` | `check` only: `{ goto: <step id>, maxRounds }` |
| `onBlocked` | Route per `blockerKind` outside a loop, e.g. `{ "findings": { "goto": "gauge", "maxRounds": 1 } }`; after `maxRounds` the batch becomes Stuck |
| `deadline` | Overrides the brewer's deadline for this step |

**Red proof needs a test report.** A red proof reads a structured test report, not an exit code: each repository in `foedrum.jsonc` declares `testReport` (TAP or JUnit XML, and where to find it). A recipe that needs red proof on a repository without one stops at the start of the batch as Stuck (`environment`), naming the fix.

**Parallel groups.** Every child is its own attempt with its own lease and deadline; the group ends when all children end. The group's `verdict` is `approve` only when every child that returns a verdict approves. Their time counts against the recipe budget.

**Brett's mutants are checked by the engine.** Brett proposes a few mutants as patches; the engine applies each one in a disposable `scratch` tree and runs the gravity reading. Only mutants the tests do not catch are **confirmed survivors**. They are listed in the pull request description and handed to the Cooper together with the lens findings whenever it runs; they block the verdict only when `"blocking": true`.

**Skipped steps.** An input from a skipped step is left out, and a `goto` or `onBlocked` route to a skipped step makes the batch Stuck (`divergence`) instead of jumping. With `testFirst` off, Cellarman therefore gets no `tests` in-doc, and "this test is wrong" goes to a human.

**Test-first in bug-fix recipes.** The Microbiologist's reproducing test is the failing test: its step has `"id": "triage"`, the red proof uses `"of": "triage"`, and no Gauger step is needed.

**Escalation:** a brewer may set `"escalate": "<recipe>"` in its out doc; the batch re-routes (for example Enkel → Tripel).

## 4. How a brewer runs

A brewer compiles to one `claude` CLI invocation plus a generated per-attempt settings file:

```
claude --print --verbose --output-format stream-json
       --permission-mode dontAsk
       --model <model> --effort <effort>
       --settings <per-attempt settings: allow/deny, environment>
       [--safe-mode] [--system-prompt-file <file>]
       [--resume <session-id>]
       -p -                      # prompt via stdin
```

- The engine owns the child process, reads the event stream live (progress, tool calls, permission denials, usage) and kills the process tree on deadline, stall or cancel.
- On Windows the CLI can only be spawned through a shell; every argument is therefore validated against a strict pattern, and prompts and settings travel via stdin and files only.
- `--safe-mode` implements `context: lean`.
- Sessions are persisted for the lifetime of the batch, so anyone on the machine can step into them with `/foedrum:resume` (ADR 0019); they are cleaned up with the batch.

## 5. Default brewers

Default models are aliases in `models.jsonc`, resolved to the current model of that family; blind tasting may propose changes.

| Brewer | Role | Model | Effort |
|---|---|---|---|
| Innkeeper | Router: picks a recipe for an order (lean call) | haiku | low |
| Maltster | Gathers context: relevant code, history, constraints | sonnet | high |
| Brewmaster | Writes the plan with acceptance criteria | opus | medium |
| Gauger | Writes failing tests (and minimal stubs, no implementation) from the order and plan | sonnet | high |
| Cellarman | Makes the Gauger's tests pass without changing them | sonnet | high |
| Taster | Reviews a diff through one lens (read-only) | opus | medium |
| Brett | Mutation check: proposes plausible bugs; the engine confirms which ones the tests miss (advisory by default) | sonnet | medium |
| Cooper | Fixes review findings | sonnet | high |
| Blender | Resolves merge conflicts (bounded) | opus | medium |
| Microbiologist | Bug triage: reproduce, root cause, failing test | opus | medium |
| Lab tech | Verifies a fix in a real environment | sonnet | high |
| Tasting panel | Runs evaluations | — (uses the model under test) | — |

Default **tasting lenses** (`defaults/lenses/*.md`): correctness, security, cross-platform, design conformance. A Brewery adds or overrides lenses by committing files to `lenses/`. Test-first and lenses: [ADR 0017](adr/0017-test-first-recipes-and-tasting-lenses.md).
