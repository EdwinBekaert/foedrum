# Brewers

A brewer is a Markdown file (`brewers/<name>.md`) with JSON frontmatter.
The body is the prompt.
The frontmatter is read as JSONC (comments and trailing commas allowed); strictness comes from schema validation ([ADR 0020](../../adr/0020-jsonc-frontmatter.md)).
GitHub reads frontmatter as YAML and shows an error for a comment, so Foedrum's own `defaults/` brewers keep theirs strict JSON, which is also YAML, and GitHub shows it as a table (#402).
Schema: `src/schemas/brewer.ts` (`schemas/brewer.json`); unknown fields are rejected.
The setup command is not a brewer field: it depends on the repository, so it is in `foedrum.jsonc` ([configuration files](../recipes/configuration.md)).

## Fields

**Identity**

| Field | Purpose |
|---|---|
| `name` | Unique id, referenced by recipes |
| `description` | When to use this brewer; shown in docs, and to be read by a router once one is built ([routing](../intake/routing.md)) |
| `version` | Bumped on change; changes are evaluated before adoption |

**Prompt**

| Field | Purpose |
|---|---|
| body | Instructions with `{variables}` |
| `doneWhen` | Explicit definition of done |

**Inputs (in-docs)**

| Field | Purpose |
|---|---|
| `inputs[]` | Named documents (`name` is the `{variable}` in the body): `"from": "order"`, `"from": "recipes"` (one line per recipe, `- <name> (<type>): <description>`, filled by the engine: for a step that chooses the recipe, the Brewery's recipes but those that choose one, which it offers; for any other step, those of type `brew`, the recipes a plan's sub-orders may run with, [ADR 0232](../../adr/0232-foedrum-mash-routes-an-issue-to-the-innkeeper-whose-question-the-answer-chooses-the-recipe-by.md), [ADR 0365](../../adr/0365-a-recipe-has-a-type-mash-or-brew.md)), an earlier step's out doc (`"step:<id>"`, the file its latest succeeded attempt's brewer writes in the recipe that attempt was scheduled under, which the batch may have left since ([ADR 0309](../../adr/0309-the-attempt-plans-find-every-brewer-in-the-recipe-its-attempt-was-scheduled-under.md)), left out when the batch skipped that step or its recipe has none of that id, while a step of the recipe that no brewer runs, or a brewer's step with no succeeded attempt yet, refuses the attempt's plan, [ADR 0305](../../adr/0305-a-step-input-of-a-step-the-recipe-lacks-is-left-out.md)), the batch's latest plan (`"plan"`, its out doc where the attempt that wrote it ran, named by that attempt's brewer, filled only on a step a person's choice schedules, [ADR 0286](../../adr/0286-foedrum-lauter-corrects-a-plan-at-gate-1-in-an-interactive-session.md), or an attempt a findings route scheduled, [ADR 0318](../../adr/0318-a-plan-lens-s-findings-go-back-to-the-plan-step-and-the-plan-comment-lists-the-review-notes-left.md), and left out elsewhere; a step whose lenses review a plan gets it, the repositories and the recipes from the engine without naming any, [ADR 0312](../../adr/0312-a-taster-on-a-plan-lens-step-reads-the-batch-s-latest-plan-and-ties-each-finding-to-a-sub-order.md), [ADR 0321](../../adr/0321-mash-and-decoction-review-a-plan-through-the-plan-lenses-apart.md)), a sub-order's entry of the approved plan it was ordered from (`"plan-entry"`, read from the parent batch's recorded plan, left out of a batch that is no sub-order, [ADR 0290](../../adr/0290-a-sub-order-s-brewers-read-its-plan-entry-from-the-parent-s-recorded-plan.md)), the release a sub-order waited for (`"release"`, for each `release` blocker the release the ready set counted: its repository, its tag as written, its page and notes, each line of the notes that looks like a secret left out and counted, and the blocker's merged pull requests, read from the recorded state, left out of a batch whose sub-order waits on no release; Foedrum parses no version, [ADR 0291](../../adr/0291-a-release-blocked-sub-order-s-brewers-read-the-release-it-waited-for-as-written.md)), the checks that ran on the commit the attempt's worktree starts at (`"checks"`: each step of the batch whose latest attempt finished on that commit, with how each check ended, passed, failed with its failing tests, or not run because the repository does not have it, setup left out, and left out when no step did or the attempt has no worktree of its own, [ADR 0308](../../adr/0308-a-taster-reads-the-checks-that-ran-on-its-head-and-an-out-doc-claims-only-what-its-session-did.md)), the pull request's sections an earlier attempt of the same step wrote (`"earlier-sections"`: How it works, See it and the rows of Before and after of the latest earlier attempt that succeeded and wrote any, left out of the step's first attempt and when none did, [ADR 0353](../../adr/0353-a-fix-round-s-cellarman-reads-its-earlier-sections-and-returns-them-for-the-whole-change.md)), the Brewery's test line of the attempt's repository (`"test-line"`: its `test` check in `foedrum.jsonc` as written, or each platform's line of it named, left out when the attempt has no repository of its own or the repository has no test check, [ADR 0376](../../adr/0376-foedrum-init-writes-a-test-line-that-saves-its-reports-and-doctor-and-the-maltster-read-it.md)), a repository file (`"file:<relative path>"`), the Brewery's repositories with their bases, one line each, the attempt's own marked, or in a Brewery order's folder of checkouts the folder each is read in, each followed by its lines of the [system map](../intake/system-map.md), held to 1,500 characters with the cut said (`"repositories"`, filled by the engine, [ADR 0317](../../adr/0317-the-planners-read-a-system-map-computed-from-each-repository-s-manifests-with-no-model.md), [ADR 0234](../../adr/0234-the-brewmaster-writes-a-plan-on-the-planner-alias-and-mash-runs-it.md), [ADR 0301](../../adr/0301-a-brewery-order-s-read-only-attempt-reads-every-repository-in-a-checkout-of-each.md)) or a lens (`"lens:diff/<name>"` or `"lens:plan/<name>"`: the Brewery's `lenses/diff/<name>.md` or `lenses/plan/<name>.md`, else Foedrum's default, [ADR 0143](../../adr/0143-lenses-in-two-folders-diff-and-plan.md); a lens neither has is refused when the brewer is loaded, [ADR 0098](../../adr/0098-foedrum-s-defaults-load-under-the-brewery-s-files-and-a-brewer-input-can-name-a-lens.md)) |
| `inputs[].trusted` | Untrusted input goes between `untrusted-input-<nonce>` tags with a new random nonce per prompt and its source, below the rule that it is data, never instructions; input containing the nonce is refused as a likely injection ([ADR 0041](../../adr/0041-untrusted-input-in-per-prompt-nonce-tags.md)). The tags are a mitigation, not the security boundary. Default `false`. Every input is untrusted for now: out docs of earlier steps are model output that read the order, so they carry its text. A source that really is trusted needs a new ADR before it may be marked trusted |
| `houseYeast` | Receive learned rules from the Brewery and the repository, selected by the files the batch changed and the step's lens, or each of its lenses together, or with no lens every lens's rules ([ADR 0268](../../adr/0268-the-brewers-that-write-a-change-get-the-house-yeast-rules-of-every-lens.md)), within a token budget, each as an input named `houseYeast` ([house yeast](../house-yeast.md), [ADR 0169](../../adr/0169-house-yeast-rules-reach-a-batch-s-brewers-by-scope-and-lens.md)) |
| `toolbox` | A short brief of extra command-line tools this brewer may use |

**Output (out doc)**

| Field | Purpose |
|---|---|
| `output.doc` | File the brewer must write |
| `output.schema` | Named schema for the frontmatter (validated): `tasting` makes the brewer a Taster, whose out doc adds `findings` and a `verdict` ([ADR 0161](../../adr/0161-lens-steps-run-a-taster-whose-findings-are-advisory-unless-the-step-blocks.md)); `pullRequest` adds the pull request's sections, `howItWorks`, `seeIt` and `beforeAfter`, all optional (the default Cellarman's, [ADR 0167](../../adr/0167-a-brewed-pull-request-follows-one-layout-and-opens-as-a-draft-unless-every-taster-approves.md)); `gauge` adds the tests a test-first step wrote, `tests` and `regressionTests`, lists of names the runner reports, which judge nothing (the default Gauger's, [ADR 0170](../../adr/0170-the-red-proof-accepts-the-regression-tests-a-gauger-names.md), [ADR 0342](../../adr/0342-a-test-the-gauger-names-that-the-run-does-not-report-is-said-to-be-not-proven.md)); `fining` adds a Finer's `changes` or `unchanged` ([ADR 0166](../../adr/0166-the-finer-simplifies-a-batch-s-change-before-green.md)); `plan` adds a plan's `subOrders` and `alternatives`, whose paths the engine checks after a `done` ([work breakdown](../intake/work-breakdown.md), [ADR 0233](../../adr/0233-a-plan-is-an-out-doc-whose-paths-the-engine-checks-shown-as-one-comment-per-order.md)); `survey` adds why a test map is as it is, `map` (`new` or `stale`, which the Maltster writes, or `fresh` and `brewery`, which only the engine writes) and up to 10 `stale` paths (the default Maltster's, [the test map](../checks/test-map.md), [ADR 0298](../../adr/0298-the-maltster-s-survey-ends-without-a-session-for-a-fresh-map-and-its-check-sends-a-disagreement-back-once.md)); `mutants` adds up to 5 `mutants`, each a one-line edit the engine checks against the batch's change (the default Brett's, [tasting](tasting.md), [ADR 0311](../../adr/0311-brett-s-mutants-of-a-target-land-on-lines-the-change-added-in-a-code-area-of-the-test-map.md)); `recipeChoice` makes the brewer ask which recipe brews the order (the default Innkeeper's, [the out doc contract](out-doc.md), [ADR 0232](../../adr/0232-foedrum-mash-routes-an-issue-to-the-innkeeper-whose-question-the-answer-chooses-the-recipe-by.md)); any other name is read against the out doc contract |
| `produces` | Expected side effects: `commits`, `report`, `comment`, `none` |

**Model**

| Field | Purpose |
|---|---|
| `model` | Alias resolved through `models.jsonc`, so evaluations can swap it |
| `effort` | Reasoning effort; constant across retries to keep the prompt cache valid |

**Tools and context**

| Field | Purpose |
|---|---|
| `tools.allow` | Allowlist, including scoped shell commands (`Bash(git diff*)`). Role-level only: the repository adds its toolchain commands ([ADR 0023](../../adr/0023-language-independent-recipes.md)). Never a shell rule that reaches git with no fixed subcommand (`Bash`, `Bash(git *)`, `Bash(git -C *)`, `Bash(/usr/bin/git *)`, `Bash(env git *)`, `Bash(npm exec *)`, which runs any command as `npx`, `bunx` and `pnpx` do, and so do `pnpm`, `yarn` and `bun` by their runners, and by any other subcommand, which is read as the program it runs, as is the word after `corepack`; `Bash(npm *)`, with an option or a star where the subcommand would be; a PowerShell program word is read without `.ps1`, and git or `gh` after a wrapper is found after `=` too: [ADR 0165](../../adr/0165-a-brewer-s-tool-rules-read-a-package-manager-s-runner-as-a-wrapper.md)) or with one that pushes (`push`, `send-pack`, `http-push`, `subtree`, `submodule`): a push with options before it gets past every deny rule, so a push is denied only when no allow rule matches it ([ADR 0062](../../adr/0062-brewers-never-allow-git-with-no-fixed-subcommand.md)). Never a rule that may start `gh` (`Bash(gh *)`, `Bash(/usr/bin/gh *)`, `Bash(env gh *)`, `Bash(env g""h *)`) or ask git's credential helper, which is `gh`, for the login (`Bash(git credential *)`), with any arguments: `gh` answers from the maintainer's login, and only the engine talks to GitHub ([ADR 0082](../../adr/0082-brewers-never-allow-gh.md)). A bare `Read`, `Edit` or `Write` reaches only the worktree in the attempt; never a `Write`, `MultiEdit`, `NotebookEdit` or `Glob` path rule, here or in `tools.deny`, which Claude Code never consults: write `Edit(…)` or `Read(…)` ([ADR 0093](../../adr/0093-brewers-file-tool-rules-are-read-and-edit-rules-scoped-to-the-worktree.md)) |
| `tools.deny` | Denylist; `AskUserQuestion` and `git push` are always denied |
| `skills`, `mcp` | Claude Code skills, plugins or MCP servers this brewer may use (default: none) |
| `context` | `lean` (default: no project instructions, hooks, plugins or MCP load; a brewer's prompt may still ask it to read them, [ADR 0331](../../adr/0331-a-taster-on-a-diff-reads-the-repository-s-rules-as-its-standard.md)) or `repo` (load the target repository's instructions) |

**Permissions and workspace**

| Field | Purpose |
|---|---|
| `access` | `read` or `write` |
| `tree` | `task` worktree, `integration` tree, a fresh read-only checkout, or a disposable `scratch` tree that is discarded after the attempt. With `task`, each attempt gets a worktree of its own at the batch's task tree: the commits of the latest attempt that succeeded (uncommitted files do not carry over), or of the latest rewind, else the base; an attempt that resumes a session (`retryMode: resume`) runs in the worktree that session ran in instead ([ADR 0117](../../adr/0117-a-retry-resumes-the-session-of-the-attempt-before-it-in-that-attempt-s-worktree.md), [ADR 0118](../../adr/0118-retrymode-resume-loads-and-an-answer-resumes-the-session-that-asked.md)). Only `task` loads for now ([ADR 0066](../../adr/0066-the-task-tree-continues-from-the-latest-succeeded-attempt.md)) |
| `git` | `commit: true/false`. With `true` the attempt allows `Bash(git status *)`, `Bash(git add *)` and `Bash(git commit *)`, and the out doc contract tells the brewer to commit; a brewer that needs another git subcommand names it in `tools.allow` ([ADR 0074](../../adr/0074-git-commit-grants-fixed-git-rules-and-done-needs-a-commit.md)). Pushing is always the engine's job |
| `env` | Extra environment variables on top of a minimal base. The runner builds the environment from a minimal base, then this `env`, then its own variables last, comparing names without case on Windows (`buildBrewerEnv`, [ADR 0028](../../adr/0028-brewer-runner-outcomes-environment-and-test-first.md)); names it owns are rejected when the brewer is loaded, in any case: `NODE_*`, `npm_config_*`, `PATH`, `PATHEXT`, `COMSPEC`, `SYSTEMROOT`, `HOME`, `USERPROFILE`, `APPDATA`, `ANTHROPIC_*`, `CLAUDE_*`, `GIT_*`, `SSH_*`, `LD_*`, `DYLD_*`, `BASH_ENV`, `ENV` and `*_PROXY`, as are two names that differ only in case. The GitHub tokens (`GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, `GITHUB_ENTERPRISE_TOKEN`) are refused too, in any case: the runner never sets them, but a push could carry one. The runner's own variables keep npm's lifecycle scripts off and leave git no push credential: `GIT_TERMINAL_PROMPT=0` and, through `GIT_CONFIG_COUNT` (git 2.31 or later; doctor requires 2.38, ADR 0200), an empty `credential.helper`, `core.askPass` and `http.cookieFile`, `http.emptyAuth=false` and no transport but local paths, git, http and https (`brewerForcedEnv`, [ADR 0109](../../adr/0109-a-brewer-s-git-holds-no-push-credential.md); a netrc file in the user's home and the user's `http.<url>.*` keys are not covered); a brewer, or a check step, cannot fetch a private repository or anything over ssh. They also set `DISABLE_AUTOUPDATER=1` and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, so claude neither updates itself mid-brew nor sends telemetry, error reports or feature-flag requests, whatever the user's environment says; `DISABLE_AUTOUPDATER` is the one name the runner owns that a brewer's `env` may still name, and the forced value replaces it ([ADR 0177](../../adr/0177-brewers-run-without-claude-s-auto-updater-and-nonessential-traffic.md)) |

Headless brewers always run in a permission mode where the allowlist decides and nothing waits for an approver.

**Budget, watchdog and retries**

| Field | Purpose |
|---|---|
| `deadline` | Wall-clock limit per attempt |
| `maxTurns` | Turn limit |
| `stall` | No file write or commit for N turns or M minutes → abort; the batch becomes Stuck (`stalled`, [ADR 0027](../../adr/0027-supervisor-lost-and-stalled-attempts.md)). The runner sees a `Write`, `Edit`, `MultiEdit` or `NotebookEdit` call, or a shell command whose subcommand of `git` is `commit` (ADR 0048), that succeeded; files changed by other shell commands count only once committed ([ADR 0047](../../adr/0047-the-claude-brewer-runner-its-stream-endings-and-progress.md)) |
| `maxAttempts` | Attempts per round before the batch becomes Stuck: those since the step's latest that delivered, a success or blocked by findings, so a failure closes no round and a person's `retry` gives one more; this generalises the counts a plan step and a diff lens step kept before ([ADR 0325](../../adr/0325-a-step-counts-its-attempts-per-round.md), [ADR 0289](../../adr/0289-a-step-that-writes-a-plan-counts-its-attempts-since-its-latest-plan.md), [ADR 0324](../../adr/0324-a-diff-lens-step-counts-its-attempts-since-its-latest-review.md), [ADR 0053](../../adr/0053-recipe-files-reach-the-engine-brewer-steps-in-a-line-first.md)); a route's `maxRounds` bounds the rounds ([ADR 0064](../../adr/0064-test-first-recipes-when-onblocked-and-a-red-proof-required.md)) |
| `retryMode` | `resume` (same session) or `fresh` (new session with the same in-docs); while `foedrum resume` drives a running batch, every retry or answer of it continues its session whatever this says ([ADR 0127](../../adr/0127-foedrum-resume-takes-a-running-batch-over-and-continues-its-step-s-session.md)), and so does the retry of a run that went past `maxTurns` ([ADR 0175](../../adr/0175-a-turn-overrun-is-retried-by-resuming-its-session-and-keeps-its-out-doc.md)) |
| `maxDenials` | Permission denials per attempt before aborting with `blocker_kind: environment` |
| `checksBeforeEnd` | `true`: once its session ends done with commits, the runner runs the repository's quick checks and sends the first failure back to that session once ([how a brewer runs](how-a-brewer-runs.md), [ADR 0381](../../adr/0381-a-brewer-that-writes-code-runs-the-quick-checks-before-its-end-and-is-sent-back-once.md)); the default Cellarman and Finer set it |

**Guards** — deterministic post-conditions checked by the engine

| Guard | Fails when |
|---|---|
| `requiresOutDoc` | the out doc is missing or invalid |
| `requiresCommits` | the out doc says `done`, but the brewer made no commit after its worktree's start: the batch goes Stuck on a `divergence`. Every brewer that produces commits has it, listed or not ([ADR 0074](../../adr/0074-git-commit-grants-fixed-git-rules-and-done-needs-a-commit.md)), except for a `fining` out doc's `done` with `unchanged`, which needs none ([ADR 0166](../../adr/0166-the-finer-simplifies-a-batch-s-change-before-green.md)) |
| `testsNotRemoved` | test declarations disappeared compared with the attempt's start commit |
| `testsUnchanged` | a line the step named in the red proof's `of` added to a separate test file of the test map was changed or removed, or a separate test file the batch's base holds was changed or removed ([ADR 0358](../../adr/0358-an-older-test-changes-only-in-the-gauger-s-red-commit.md)) (new tests may change, and fixtures and stubs outside the map's test areas; with no map, the attempt is blocked on its environment; [the red proof](../checks/red-proof.md)) |
| `scope` | files outside the worktree were touched |
| `diffLimits` | more files or lines changed than allowed |
| `testMapOnly` | the attempt's commits changed any file but `.foedrum/test-map.jsonc`: the attempt fails retryably, naming up to 10 of them; a git read that fails blocks it on its environment ([ADR 0298](../../adr/0298-the-maltster-s-survey-ends-without-a-session-for-a-fresh-map-and-its-check-sends-a-disagreement-back-once.md)) |

There is no `noPush` guard: a brewer that names it fails the load, and a brewer's git holds no push credential instead ([ADR 0133](../../adr/0133-the-nopush-guard-goes-a-brewer-s-git-holds-no-push-credential.md)).

## Prompt assembly

Every brewer prompt is built by one function, `assembleBrewerPrompt` (`src/brewers/prompt.ts`): the instructions, then the rule, then each input between `untrusted-input-<nonce>` tags with its source ([ADR 0041](../../adr/0041-untrusted-input-in-per-prompt-nonce-tags.md)).
Each input comes from one of the sources the `inputs[]` row of [Fields](#fields) lists; a lens input is read when the brewer is loaded, the Brewery's lens of that folder and name first, else Foedrum's default ([ADR 0098](../../adr/0098-foedrum-s-defaults-load-under-the-brewery-s-files-and-a-brewer-input-can-name-a-lens.md)).
A later round of a Taster's step also gets `earlierFindings`, the earlier rounds' findings with their dispositions ([tasting](tasting.md), [ADR 0191](../../adr/0191-the-step-a-findings-route-goes-back-to-records-a-disposition-for-each-finding.md)).
After them come the answers to the step's questions ([ADR 0059](../../adr/0059-attempt-plans-from-the-brewer-of-the-step.md); a brewer that resumes gets this round's answers in its own session instead, and a resumed retry, except after a turn overrun, the reason the attempt before it failed, and a resumed routed fix also the files its kept merge still has unmerged ([ADR 0244](../../adr/0244-a-conflict-with-the-moved-base-sends-its-batch-back-to-the-fix-step.md)), [ADR 0248](../../adr/0248-a-retry-is-told-why-the-attempt-before-it-failed.md), [ADR 0118](../../adr/0118-retrymode-resume-loads-and-an-answer-resumes-the-session-that-asked.md), and each the comments made since it last read them ([ADR 0338](../../adr/0338-a-resumed-session-hears-the-comments-made-since-it-last-read-them.md))) and, for an attempt an `onFail`, `onBlocked`, `onFindings` or `onPullRequestFail` route scheduled, the `route` input: the failed checks, the out doc (from a child of a parallel group with the other children's findings of that round, [ADR 0349](../../adr/0349-a-group-s-round-back-carries-every-finding-of-the-round.md)), or the checks that failed on the pull request's head, or the check that failed on its merged tree with its tail ([ADR 0226](../../adr/0226-a-failing-check-on-the-merged-tree-sends-its-batch-back-to-the-fix-step.md)), or the files its kept start merge left unmerged, with their status ([ADR 0244](../../adr/0244-a-conflict-with-the-moved-base-sends-its-batch-back-to-the-fix-step.md)), that sent it back ([ADR 0128](../../adr/0128-an-attempt-a-route-schedules-gets-what-sent-it-back.md), [ADR 0219](../../adr/0219-a-failing-check-on-an-open-pull-request-sends-its-batch-back-to-a-fix-step.md)), a fresh retry or answer of such an attempt getting it too ([ADR 0325](../../adr/0325-a-step-counts-its-attempts-per-round.md)), and last, for a fresh retry after the secret scan failed the attempt before it, why, with the advice to build a key-shaped value at run time ([ADR 0187](../../adr/0187-a-committing-brewer-s-attempt-is-scanned-for-secrets-when-it-ends-done.md)), or for a fresh retry after any other failure, the `retry` input: that attempt's reason ([ADR 0248](../../adr/0248-a-retry-is-told-why-the-attempt-before-it-failed.md)).

## Example

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
    "allow": ["Read", "Edit", "Write", "Grep", "Glob", "Bash(git diff*)"],
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
  "guards": ["requiresOutDoc", "requiresCommits", "testsNotRemoved", "testsUnchanged", "scope"]
}
---
Implement the plan in {plan} for the order below. The Gauger's failing tests in {tests}
are the specification: make them pass without changing them. If a test is wrong,
report it as a finding instead of editing it.

Done when: every plan step is done, the Gauger's tests and the full test suite pass,
and everything is committed.
```
