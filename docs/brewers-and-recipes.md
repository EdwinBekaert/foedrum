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
| `houseYeast` | Inject the Brewery's learned rules |
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
| `tree` | `task` worktree, `integration` tree, or a fresh read-only checkout |
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
| `noPush` | the branch moved on the remote |
| `scope` | files outside the worktree were touched |
| `diffLimits` | more files or lines changed than allowed |

### 1.2 Example

```markdown
---
{
  "name": "cellarman",
  "description": "Implements an approved plan in one repository, test-first.",
  "version": 1,
  "model": "builder",
  "effort": "high",
  "inputs": [
    { "name": "order", "from": "order", "trusted": false },
    { "name": "plan", "from": "step:plan" }
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
  "guards": ["requiresOutDoc", "requiresCommits", "testsNotRemoved", "noPush", "scope"]
}
---
Implement the plan in {plan} for the order below, test-first.

Done when: every plan step is done, each acceptance criterion is covered by a test,
the full test suite passes, and everything is committed.
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
| `needs_input` | Stuck 🔔 with the questions; the answer starts the next attempt (`--resume` with the answers, or a fresh attempt with a `qa.md` in-doc) |
| `blocked` + `findings` | Next loop round, until `maxRounds` |
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
  "steps": [
    { "brewer": "brewmaster" },                              // writes plan.md
    { "brewer": "cellarman" },                               // code + commits
    { "check": ["typecheck", "lint", "test"],                // gravity reading, no model tokens
      "onFail": { "goto": "cellarman", "maxRounds": 2 } },
    { "loop": {                                              // review/fix loop
        "maxRounds": 2,
        "until": "taster.verdict == 'approve'",
        "steps": [
          { "brewer": "taster" },                            // read-only review
          { "brewer": "cooper", "when": "taster.verdict != 'approve'" }
        ]
      },
      "onExhausted": "stuck" },
    { "action": "openPullRequest" }
  ]
}
```

**Step kinds:** `brewer` · `check` (gravity reading: a shell command or a built-in check) · `gate: "human"` (approval with a deadline) · `action` (`openPullRequest`, `comment`, `label`, `blend`) · `fanOut` (child orders per repository, scheduled as a dependency graph).

**Escalation:** a brewer may set `"escalate": "<recipe>"` in its out doc; the batch re-routes (for example Enkel → Tripel).

## 4. How a brewer runs

A brewer compiles to one `claude` CLI invocation plus a generated per-attempt settings file:

```
claude --print --verbose --output-format stream-json
       --permission-mode dontAsk
       --model <model> --effort <effort>
       --settings <per-attempt settings: allow/deny, environment>
       [--safe-mode] [--system-prompt-file <file>] [--no-session-persistence]
       [--resume <session-id>]
       -p -                      # prompt via stdin
```

- The engine owns the child process, reads the event stream live (progress, tool calls, permission denials, usage) and kills the process tree on deadline, stall or cancel.
- On Windows the CLI can only be spawned through a shell; every argument is therefore validated against a strict pattern, and prompts and settings travel via stdin and files only.
- `--safe-mode` implements `context: lean`.

## 5. Default brewers

| Brewer | Role |
|---|---|
| Innkeeper | Router: picks a recipe for an order (lean call) |
| Maltster | Gathers context: relevant code, history, constraints |
| Brewmaster | Writes the plan with acceptance criteria |
| Cellarman | Implements, test-first |
| Taster | Reviews a diff (read-only) |
| Cooper | Fixes review findings |
| Blender | Resolves merge conflicts (bounded) |
| Microbiologist | Bug triage: reproduce, root cause, failing test |
| Lab tech | Verifies a fix in a real environment |
| Tasting panel | Runs evaluations |
