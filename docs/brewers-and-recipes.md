# Brewers and recipes

Status: design (v0.1). A **brewer** is a reusable agent role. A **recipe** puts brewers, checks and actions in order, with loops. Brewers are defined first; recipes compose them.

## 1. Brewer

A brewer is a Markdown file (`brewers/<name>.md`) with JSON frontmatter. The body is the prompt. The frontmatter is read as JSONC (comments and trailing commas allowed); strictness comes from schema validation ([ADR 0020](adr/0020-jsonc-frontmatter.md)). Schema: `src/schemas/brewer.ts` (`schemas/brewer.json`); unknown fields are rejected. The setup command is not a brewer field: it depends on the repository, so it is in `foedrum.jsonc` (§6).

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
| `inputs[]` | Named documents (`name` is the `{variable}` in the body): `"from": "order"`, an earlier step's out doc (`"step:<id>"`) or a repository file (`"file:<relative path>"`) |
| `inputs[].trusted` | Untrusted input is wrapped in delimiters and marked as data, never instructions. Default `false`; the order is never trusted |
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
| `tools.allow` | Allowlist, including scoped shell commands (`Bash(git diff*)`). Role-level only: the repository adds its toolchain commands ([ADR 0023](adr/0023-language-independent-recipes.md)) |
| `tools.deny` | Denylist; `AskUserQuestion` and `git push` are always denied |
| `skills`, `mcp` | Claude Code skills, plugins or MCP servers this brewer may use (default: none) |
| `context` | `lean` (default: no project instructions, hooks, plugins or MCP) or `repo` (load the target repository's instructions) |

**Permissions and workspace**

| Field | Purpose |
|---|---|
| `access` | `read` or `write` |
| `tree` | `task` worktree, `integration` tree, a fresh read-only checkout, or a disposable `scratch` tree that is discarded after the attempt |
| `git` | `commit: true/false`; pushing is always the engine's job |
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
    "allow": ["Read", "Edit", "Write", "Grep", "Glob", "Bash(git add*)", "Bash(git commit*)", "Bash(git diff*)"],
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

A recipe is a JSONC file (`recipes/<name>.jsonc`) with a `$schema` reference for editor autocompletion. Schema: `src/schemas/recipe.ts` (`schemas/recipe.json`). Foedrum's own recipes are checked as `DefaultRecipe`, which also rejects literal commands.

```jsonc
{
  "$schema": "../.foedrum/schemas/recipe.json",          // written by `foedrum init`
  "name": "half-pint",
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
              { "id": "test-design", "brewer": "taster", "lens": "test-design" },
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

**Step kinds:** `brewer` · `session` (an interactive step that runs in an engineer's Claude Code session: `refine`, `triage` or `review`; under the autonomous driver it waits visibly in the Stuck lane, with a reminder, a deadline and an optional automated fallback) · `check` (gravity reading: a named check, `build`, `typecheck`, `lint`, `format` or `test`, resolved through the repository's commands in `foedrum.jsonc` ([ADR 0023](adr/0023-language-independent-recipes.md)), or a list of them; in a Brewery's own recipe also a literal shell command, written as an object, `{ "run": "…", "windows": "…" }`, so a mistyped check name is an error, never a command) · `parallel` (a group of brewer steps run side by side; none of them writes the task tree) · `loop` · `gate: "human"` (approval with a required `deadline`) · `action` (`openPullRequest`, `comment`, `label`, `blend`) · `fanOut` (child orders per repository, scheduled as a dependency graph: `recipe` for every sub-order, otherwise the router picks; `approval`, default `true`; `bottling`: `perSubOrder` (default), `perRepo` or `manual`).

A step has exactly one of these kind fields. A `session` step needs a `deadline` and may name a `fallback` brewer.

**Recipe fields:** `name`, `description`, `match` (`labels`), `budget` (`minutes`), `steps`, and `testFirst` (default `true`; the router may switch it off for documentation-only or pure refactoring orders and records why in the status comment).

**Step fields**

| Field | Purpose |
|---|---|
| `id` | Unique step id within the recipe, nested loop and parallel steps included. Expressions (`tasting.verdict`), `goto`, `of` and `from: "step:<id>"` refer to it, and every reference must name a step. It is a file name on the state branch, so it follows `PathSafeId` (`src/schemas/ids.ts`): 1 to 64 lower-case letters, digits, `.`, `_` or `-`, a letter or digit at both ends, no Windows device name; `recipe` is reserved. Required, except on brewer steps (default: the brewer name) and actions (default: the action in kebab case, `open-pull-request`) |
| `when` | Run the step only when the expression is true; otherwise it is skipped and recorded as skipped. Expressions read step results by id (`tasting.verdict`, `mutants.survivors`) and the recipe's settings after routing (`recipe.testFirst`), optionally compared with a value in single quotes (`tasting.verdict != 'approve'`) |
| `lens` | Taster only: the lens file (`lenses/<lens>.md`) that sets the review focus |
| `expect` | `check` only: `"pass"` (default) or `"fail"`. `"fail"` is a **red proof**, which runs `"check": "test"` only, because it reads the test report |
| `of` | Red proof only: the step whose committed tests must fail because the behaviour is missing (a failed assertion or an error thrown by the code under test); load, compile, import or collection errors do not count |
| `blocking` | Brett only: `true` makes confirmed surviving mutants block the tasting verdict (default `false`, advisory) |
| `onFail` | `check` only: `{ goto: <step id>, maxRounds }` |
| `onBlocked` | Brewer steps only: route a `findings` blocker outside a loop, e.g. `{ "findings": { "goto": "gauge", "maxRounds": 1 } }`; after `maxRounds` the batch becomes Stuck. `environment` and `divergence` blockers are always Stuck (§2), so they take no route |
| `deadline` | Overrides the brewer's deadline for this step |

**Red proof needs a test report.** A red proof reads a structured test report, not an exit code: each repository in `foedrum.jsonc` declares `testReport` (TAP or JUnit XML, and where to find it). A recipe that needs red proof on a repository without one stops at the start of the batch as Stuck (`environment`), naming the fix.

**Parallel groups.** Every child is its own attempt with its own lease and deadline; the group ends when all children end. The group's `verdict` is `approve` only when every child that returns a verdict approves. Their time counts against the recipe budget.

**Brett's mutants are checked by the engine.** Brett proposes a few mutants as patches; the engine applies each one in a disposable `scratch` tree and runs the gravity reading. Only mutants the tests do not catch are **confirmed survivors**. They are listed in the pull request description and handed to the Cooper together with the lens findings whenever it runs; they block the verdict only when `"blocking": true`.

**Skipped steps.** An input from a skipped step is left out, and a `goto` or `onBlocked` route to a skipped step makes the batch Stuck (`divergence`) instead of jumping. With `testFirst` off, Cellarman therefore gets no `tests` in-doc, and "this test is wrong" goes to a human.

**Test-first in bug-fix recipes.** The Microbiologist's reproducing test is the failing test: its step has `"id": "triage"`, the red proof uses `"of": "triage"`, and no Gauger step is needed.

**Escalation:** a brewer may set `"escalate": "<recipe>"` in its out doc; the batch re-routes (for example Half-pint → Growler).

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

Default **tasting lenses** (`defaults/lenses/*.md`): correctness, security, cross-platform, design conformance, test design. A Brewery adds or overrides lenses by committing files to `lenses/`. Test-first and lenses: [ADR 0017](adr/0017-test-first-recipes-and-tasting-lenses.md); the fifth lens: [ADR 0022](adr/0022-five-default-lenses.md).

## 6. Configuration files

Both are JSONC with a `$schema` reference for editor autocompletion; unknown fields are rejected.

**`foedrum.jsonc`** (`src/schemas/brewery-config.ts`, `schemas/foedrum.json`) maps each registered repository's checks to commands ([ADR 0023](adr/0023-language-independent-recipes.md)):

```jsonc
{
  "$schema": "./.foedrum/schemas/foedrum.json",                  // written by `foedrum init`
  "permissionCeiling": ["Bash(npm *)", "Bash(dotnet *)"],       // the most a repository may add
  "repositories": {
    "acme/billing": {
      "checks": {                                                // all five, a command or null
        "build": "dotnet build",
        "typecheck": null,                                       // not available: skipped and recorded
        "lint": null,
        "format": { "run": "dotnet format --verify-no-changes", "windows": "…" },
        "test": "dotnet test --logger junit"
      },
      "testReport": { "format": "junit", "path": "tests/TestResults/results.xml" },
      "setup": { "command": "dotnet restore", "timeout": "15m" },  // once per worktree
      "tools": ["Bash(dotnet test*)", "Bash(dotnet build*)"],    // added to every brewer's allowlist
      "houseYeast": "repo"                                       // or "brewery" (ADR 0018)
    }
  }
}
```

- `checks` requires all five keys, so a missing check is always an explicit `null`. A command is one line, or `{ "run", "windows", "macos", "linux" }` with per-OS overrides.
- `testReport` is `{ "format": "tap" }` (the test command writes TAP to standard output), `{ "format": "tap", "path": … }` or `{ "format": "junit", "path": … }`; the path is relative to the worktree and never leaves it. A test report needs a `test` command.
- Every `tools` rule must stay within `permissionCeiling`: a ceiling rule covers the same tool when it has no specifier, or when its specifier, with `*` matching any text, matches the rule's specifier (`Bash(dotnet *)` covers `Bash(dotnet test*)`, not the other way round). Without a ceiling, a repository adds no tools. `AskUserQuestion` is never allowed.
- Repository keys are `owner/name`, unique regardless of case.
- Durations (`timeout`, `deadline`) are a whole number with `s`, `m`, `h` or `d`: `"90s"`, `"30m"`, `"3d"`.

**`models.jsonc`** (`src/schemas/models.ts`, `schemas/models.json`) maps the aliases brewers name in `model` to a model id or family, and optionally gives one brewer another alias, as blind tasting does:

```jsonc
{
  "$schema": "./.foedrum/schemas/models.json",
  "models": { "builder": "claude-sonnet-5-5", "reviewer": "opus", "candidate": "claude-opus-5-5[1m]" },
  "brewers": { "cellarman": "candidate" }                       // must name an alias above
}
```

Model ids reach the `claude` command line, so they are limited to lower-case letters, digits, `.`, `_`, `:` and `-` (plus a `[1m]` suffix), and never start with `-`.

**House-yeast rules** (`src/schemas/house-yeast.ts`, `schemas/house-yeast.json`) carry the frontmatter of [ADR 0018](adr/0018-house-yeast-layers.md): `id`, `scope` (`globs`, `language`, `lens`, all optional), `kind`, `source`, `created` (a date) and `status`.
