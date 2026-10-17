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
| `inputs[].trusted` | Untrusted input goes between `untrusted-input-<nonce>` tags with a new random nonce per prompt and its source, below the rule that it is data, never instructions; input containing the nonce is refused as a likely injection ([ADR 0041](adr/0041-untrusted-input-in-per-prompt-nonce-tags.md)). The tags are a mitigation, not the security boundary. Default `false`. Every input is untrusted for now: out docs of earlier steps are model output that read the order, so they carry its text. A source that really is trusted needs a new ADR before it may be marked trusted |
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
| `tools.allow` | Allowlist, including scoped shell commands (`Bash(git diff*)`). Role-level only: the repository adds its toolchain commands ([ADR 0023](adr/0023-language-independent-recipes.md)). Never a shell rule that reaches git with no fixed subcommand (`Bash`, `Bash(git *)`, `Bash(git -C *)`, `Bash(/usr/bin/git *)`, `Bash(env git *)`) or with one that pushes (`push`, `send-pack`, `http-push`, `subtree`, `submodule`): a push with options before it gets past every deny rule, so a push is denied only when no allow rule matches it ([ADR 0062](adr/0062-brewers-never-allow-git-with-no-fixed-subcommand.md)) |
| `tools.deny` | Denylist; `AskUserQuestion` and `git push` are always denied |
| `skills`, `mcp` | Claude Code skills, plugins or MCP servers this brewer may use (default: none) |
| `context` | `lean` (default: no project instructions, hooks, plugins or MCP) or `repo` (load the target repository's instructions) |

**Permissions and workspace**

| Field | Purpose |
|---|---|
| `access` | `read` or `write` |
| `tree` | `task` worktree, `integration` tree, a fresh read-only checkout, or a disposable `scratch` tree that is discarded after the attempt. With `task`, each attempt gets a worktree of its own at the batch's task tree: the commits of the latest attempt that succeeded (uncommitted files do not carry over), or of the latest rewind, else the base. Only `task` loads for now ([ADR 0066](adr/0066-the-task-tree-continues-from-the-latest-succeeded-attempt.md)) |
| `git` | `commit: true/false`; pushing is always the engine's job |
| `env` | Extra environment variables on top of a minimal base. The runner builds the environment from a minimal base, then this `env`, then its own variables last, comparing names without case on Windows (`buildBrewerEnv`, [ADR 0028](adr/0028-brewer-runner-outcomes-environment-and-test-first.md)); names it owns are rejected when the brewer is loaded, in any case: `NODE_*`, `npm_config_*`, `PATH`, `PATHEXT`, `COMSPEC`, `SYSTEMROOT`, `HOME`, `USERPROFILE`, `APPDATA`, `ANTHROPIC_*`, `CLAUDE_*`, `GIT_*`, `SSH_*`, `LD_*`, `DYLD_*`, `BASH_ENV`, `ENV` and `*_PROXY`, as are two names that differ only in case |

Headless brewers always run in a permission mode where the allowlist decides and nothing waits for an approver.

**Budget, watchdog and retries**

| Field | Purpose |
|---|---|
| `deadline` | Wall-clock limit per attempt |
| `maxTurns` | Turn limit |
| `stall` | No file write or commit for N turns or M minutes → abort; the batch becomes Stuck (`stalled`, [ADR 0027](adr/0027-supervisor-lost-and-stalled-attempts.md)). The runner sees a `Write`, `Edit`, `MultiEdit` or `NotebookEdit` call, or a shell command whose subcommand of `git` is `commit` (ADR 0048), that succeeded; files changed by other shell commands count only once committed ([ADR 0047](adr/0047-the-claude-brewer-runner-its-stream-endings-and-progress.md)) |
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

The only text Foedrum adds to every brewer prompt, besides the rule about tagged input when the brewer has inputs ([ADR 0041](adr/0041-untrusted-input-in-per-prompt-nonce-tags.md)):

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

**Loading.** The Brewery's recipe files and the brewer files they name load all or nothing (`loadRecipes`, [ADR 0053](adr/0053-recipe-files-reach-the-engine-brewer-steps-in-a-line-first.md)): a file must hold the recipe or brewer it is named after, every brewer a recipe names needs a file, and one file that does not load stops every command that needs recipes with the line `foedrum doctor` gives (`the Brewery's recipes are not valid: <file>: <problem>; …`). For now the engine brews only brewer steps in a line, without `when`, `onBlocked`, `lens` or `blocking`: a step's deadline is its own or its brewer's, its stall limit and `maxAttempts` are its brewer's, a deadline is at most 365 days, and after the last step the batch is done. A recipe that resolves to test-first (`resolveRecipe`) is refused too, with `set testFirst: false until test-first recipes land (#25)`. Other step kinds are refused by name until the engine runs them. A step whose brewer asks for what the attempt plan does not carry yet is refused by name too: `retryMode: resume`, `houseYeast`, `skills`, `mcp`, `context: repo`, `toolbox`, `doneWhen`, or a guard other than `requiresOutDoc` ([ADR 0059](adr/0059-attempt-plans-from-the-brewer-of-the-step.md)). After the last step the batch goes on tap with no pull request, until the `openPullRequest` action lands.

**Step kinds:** `brewer` · `session` (an interactive step that runs in an engineer's Claude Code session: `refine`, `triage` or `review`; under the autonomous driver it waits visibly in the Stuck lane, with a reminder, a deadline and an optional automated fallback) · `check` (gravity reading: a named check, `build`, `typecheck`, `lint`, `format` or `test`, resolved through the repository's commands in `foedrum.jsonc` ([ADR 0023](adr/0023-language-independent-recipes.md)), or a list of them; in a Brewery's own recipe also a literal shell command, written as an object, `{ "run": "…", "windows": "…" }`, so a mistyped check name is an error, never a command) · `parallel` (a group of brewer steps run side by side; none of them writes the task tree) · `loop` · `gate: "human"` (approval with a required `deadline`) · `action` (`openPullRequest`, `comment`, `label`, `blend`) · `fanOut` (child orders per repository, scheduled as a dependency graph: `recipe` for every sub-order, otherwise the router picks; `approval`, default `true`; `bottling`: `perSubOrder` (default), `perRepo` or `manual`).

A step has exactly one of these kind fields. A `session` step needs a `deadline` and may name a `fallback` brewer.

**Recipe fields:** `name`, `description`, `match` (`labels`), `budget` (`minutes`), `steps`, and `testFirst` (default `true` for recipes that write code, decided when the recipe is loaded for a batch, since it depends on the brewers the recipe uses: unset, it is `true` when any brewer the recipe names produces `commits`, else `false` (`resolveRecipe`, [ADR 0028](adr/0028-brewer-runner-outcomes-environment-and-test-first.md)); the router may switch it off for documentation-only or pure refactoring orders and records why in the status comment).

**Step fields**

| Field | Purpose |
|---|---|
| `id` | Unique step id within the recipe, nested loop and parallel steps included. Expressions (`tasting.verdict`), `goto`, `of` and `from: "step:<id>"` refer to it, and every reference must name a step. It is a file name on the state branch, so it follows `PathSafeId` (`src/schemas/ids.ts`): 1 to 64 lower-case letters, digits, `.`, `_` or `-`, a letter or digit at both ends, no Windows device name; `recipe` is reserved. Required, except on brewer steps (default: the brewer name) and actions (default: the action in kebab case, `open-pull-request`) |
| `when` | Run the step only when the expression is true; otherwise it is skipped and recorded as skipped. Expressions read step results by id (`tasting.verdict`, `mutants.survivors`) and the recipe's settings after routing (`recipe.testFirst`), optionally compared with a value in single quotes (`tasting.verdict != 'approve'`) |
| `lens` | Taster only: the lens file (`lenses/<lens>.md`) that sets the review focus |
| `expect` | `check` only: `"pass"` (default) or `"fail"`. `"fail"` is a **red proof**, which runs `"check": "test"` only, because it reads the test report |
| `of` | Red proof only: an earlier step whose committed tests must fail because the behaviour is missing (a failed assertion or an error thrown by the code under test); load, compile, import or collection errors do not count |
| `blocking` | Brett only: `true` makes confirmed surviving mutants block the tasting verdict (default `false`, advisory) |
| `onFail` | `check` only: `{ goto: <step id>, maxRounds }`. Like `onBlocked`, it goes back to an earlier step at the same level or in an enclosing loop, never forward or into another loop's steps |
| `onBlocked` | Brewer steps only: route a `findings` blocker outside a loop, e.g. `{ "findings": { "goto": "gauge", "maxRounds": 1 } }`; after `maxRounds` the batch becomes Stuck. `environment` and `divergence` blockers are always Stuck (§2), so they take no route |
| `deadline` | Overrides the brewer's deadline for this step |

**Red proof needs a test report.** A red proof reads a structured test report, not an exit code: each repository in `foedrum.jsonc` declares `testReport` (TAP or JUnit XML, and where to find it). A recipe that needs red proof on a repository without one stops at the start of the batch as Stuck (`environment`), naming the fix.

**Parallel groups.** Every child is its own attempt with its own lease and deadline; the group ends when all children end. The group's `verdict` is `approve` only when every child that returns a verdict approves. Their time counts against the recipe budget.

**Brett's mutants are checked by the engine.** Brett proposes a few mutants, each as a one-line structured edit (`file`, `line`, `original`, `replacement`), never a patch ([ADR 0034](adr/0034-brett-mutants-as-structured-line-edits.md)). The engine checks each edit (an existing file under `src/` or `scripts/`, a line whose text is `original`, no new identifier or string), applies a valid one with an exact line replacement in a disposable `scratch` tree and runs the gravity reading. Only a test that fails because of the mutant catches it: the reading is compared test by test with the reading of the unmutated tree, so a test that fails anyway, a time budget or a coverage threshold does not count ([ADR 0040](adr/0040-brett-covers-scripts-and-kills-need-a-failing-test.md)). Only mutants the tests do not catch are **confirmed survivors**. They are listed in the pull request description and handed to the Cooper together with the lens findings whenever it runs; they block the verdict only when `"blocking": true`.

**Skipped steps.** An input from a skipped step is left out, and a `goto` or `onBlocked` route to a skipped step makes the batch Stuck (`divergence`) instead of jumping. With `testFirst` off, Cellarman therefore gets no `tests` in-doc, and "this test is wrong" goes to a human.

**Test-first in bug-fix recipes.** The Microbiologist's reproducing test is the failing test: its step has `"id": "triage"`, the red proof uses `"of": "triage"`, and no Gauger step is needed.

**Escalation:** a brewer may set `"escalate": "<recipe>"` in its out doc; the batch re-routes (for example Half-pint → Growler).

## 4. How a brewer runs

A brewer compiles to one `claude` CLI invocation plus a generated per-attempt settings file, verified against `claude` 2.1.301 ([ADR 0042](adr/0042-the-claude-command-line-and-stream-contract.md)):

```
claude --print --verbose --output-format stream-json
       --permission-mode dontAsk --permission-prompts none
       --model <model id> --effort <effort> --max-turns <maxTurns>
       --settings <per-attempt settings file: allow/deny, sandbox>
       --setting-sources ""                           # no user, project or local settings
       --tools <the built-in tools named in tools.allow>
       --disable-slash-commands                       # unless skills (not supported yet, ADR 0046)
       --strict-mcp-config [--mcp-config <file>]      # always; mcp not supported yet (ADR 0046)
       --safe-mode                                    # context: lean
       --session-id <new uuid> | --resume <session id>
       [--append-system-prompt-file <file>]
                                                      # the prompt on stdin, no prompt argument
```

- The settings file is written from a strict schema (`AttemptSettings`): `claude` silently drops a settings file that fails its validation, deny rules included. It always denies `AskUserQuestion` and `git push` in each shell the brewer has, and refuses an allow rule that reaches git with no fixed subcommand, the toolchain's included (ADR 0062). A bare tool name in `deny` removes the tool, a scoped rule denies matching calls.
- `--setting-sources ""` makes the runner's file the only one: the user's `~/.claude/settings.json` could otherwise widen the allowlist and add variables, and the repository's settings are untrusted. A test against the installed `claude` proves it with a throwaway user settings file ([ADR 0046](adr/0046-only-the-runners-settings-the-init-check-and-a-line-by-line-stream.md)).
- Before it reads anything else, the runner checks the `system/init` event against what it asked for: the session id, exactly the tools of `--tools`, permission mode `dontAsk`, and no MCP server, skill or slash command. Other `system` events may come first. A mismatch ends the attempt as `blocked` + `environment`, never retried (ADR 0046).
- The runner reads `system/init` (session id, model, permission mode, tools, CLI version), `assistant` and `user` messages (tool calls and results), `system/permission_denied` (one denial each, counted live) and the final `result` (`is_error`, `num_turns`, `terminal_reason`, `usage`); it ignores every other event type. `is_error`, not `subtype`, says whether the run failed; when the stream ends with a `result`, the exit code is 0 exactly when `is_error` is false. A run with no `result` is a crash, except one that wrote no line at all and exited with a code from 1 to 255: when its stderr names a lasting refusal (an unknown option, no login) it is the environment, and otherwise the runner starts `claude` once more after 5 s and makes a second such failure the environment ([ADR 0048](adr/0048-retried-pre-stream-failures-commit-detection-and-out-doc-identity.md)). Captured streams for the parser: `test/fixtures/claude-stream/`.
- The engine chooses the session id and passes it to the runner in the attempt's plan (`--session-id`), so the session can be recorded before the process starts ([ADR 0047](adr/0047-the-claude-brewer-runner-its-stream-endings-and-progress.md)).
- The engine owns the child process, reads the event stream live, line by line with a limit per line and none in total (`streamProcess`, ADR 0046), keeps only the facts it needs (progress, tool calls, permission denials, usage) and kills the process tree on deadline, stall or cancel.
- How the attempt ends follows from what the runner saw, by one rule shared with the fake runner (`settleAttempt`, [ADR 0028](adr/0028-brewer-runner-outcomes-environment-and-test-first.md)): a session that is not what was asked, or a failure before the model replied (an unknown model, no login, a session that cannot be resumed, refused arguments) → `blocked` + `environment`; `maxDenials` reached → `blocked` + `environment`, naming the denied tools; `maxTurns` passed → a failure that is not retried; a crash, output past the runner's limits, an error the `result` reported, garbage in the stream, or a missing, oversized or invalid out doc → a retryable failure, even next to a valid out doc; otherwise the out doc's status ([ADR 0047](adr/0047-the-claude-brewer-runner-its-stream-endings-and-progress.md)).
- On Windows the native `claude.exe` starts without a shell, inside a Job Object (ADR 0039); npm's `claude.cmd` goes through cmd.exe with every argument validated (ADR 0031). Either way, prompts and settings travel via stdin and files only, never arguments.
- `--safe-mode` implements `context: lean`: without it, `claude -p` loads the target repository's `CLAUDE.md`, hooks and MCP servers. How `context: repo` gives a brewer the repository's instructions without its hooks is open (ADR 0042).
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
      "houseYeast": "repo",                                      // or "brewery" (ADR 0018)
      "alias": "billing",                                        // batches billing-<issue>
      "intake": { "labels": ["foedrum"] }                       // claim and brew its labelled issues
    }
  }
}
```

- `checks` requires all five keys, so a missing check is always an explicit `null`. A command is one line, or `{ "run", "windows", "macos", "linux" }` with per-OS overrides.
- `testReport` is `{ "format": "tap" }` (the test command writes TAP to standard output), `{ "format": "tap", "path": … }` or `{ "format": "junit", "path": … }`; the path is relative to the worktree, never leaves it, and uses only file names Windows can create (no device names such as `con`, no trailing dot or space, none of `<>:"|?*` or control characters). A test report needs a `test` command.
- Every `tools` rule must stay within `permissionCeiling`, which fails closed ([ADR 0026](adr/0026-how-a-permission-ceiling-covers-a-rule.md)). A ceiling rule covers the same tool when it has no specifier, when its specifier is the rule's, or when its specifier, read as a glob, matches the rule's specifier (`Bash(dotnet *)` covers `Bash(dotnet test*)`, not the other way round). In a `Bash` or `PowerShell` rule a `*` never stands for a shell operator or grouping (`;&|` backtick `$<>(){}`; PowerShell runs a parenthesised argument), so `Bash(npm *)` does not cover `Bash(npm test && curl …)`. In a path rule (`Read`, `Edit`, `Write`, `MultiEdit`, `NotebookEdit`) a `*` stays within one folder and `**` crosses folders, so `Edit(docs/*)` does not cover `Edit(docs/**)`. A rule with a `..` segment, or a path rule anchored at `/` or `~`, is only covered by the same specifier or a bare tool. Without a ceiling, a repository adds no tools. `AskUserQuestion` is never allowed. A `tools` rule that reaches git with no fixed subcommand (`Bash(git *)`) is refused like a brewer's, but only when an attempt is planned, not when the file is loaded: each attempt for that repository then fails with `the brewer could not start` ([ADR 0062](adr/0062-brewers-never-allow-git-with-no-fixed-subcommand.md)).
- Repository keys are `owner/name`, unique regardless of case.
- `intake` (`labels`, at least one, and an optional `milestone`) makes the intake claim and brew the repository's open issues that pass it (ADR 0043). It needs an `alias`: a lower-case letter, then letters and digits, at most 20, unique in the Brewery; the batch of a claimed issue is `<alias>-<issue>` ([ADR 0050](adr/0050-the-intake-of-target-repository-issues.md)). `foedrum doctor` reports a `foedrum.jsonc` that does not pass the schema.
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
