# 0059. Attempt plans from the brewer of the step, and on tap without a pull request

Date: 2026-10-17 · Status: Accepted · Amends [0053](0053-recipe-files-reach-the-engine-brewer-steps-in-a-line-first.md) (what a brewer step may ask for, a step that left its file) , [0047](0047-the-claude-brewer-runner-its-stream-endings-and-progress.md) (who builds the plan) and [0043](0043-target-repository-issues-as-a-work-queue-claimed-by-a-ref.md) (`batch.on_tap` without a pull request) · Amended by [0062](0062-brewers-never-allow-git-with-no-fixed-subcommand.md), [0063](0063-foedrum-serve-its-configuration-and-wiring.md), [0066](0066-the-task-tree-continues-from-the-latest-succeeded-attempt.md), [0071](0071-the-openpullrequest-action-two-effects-of-the-batch.md) (on tap only with the pull request of the action) and [0078](0078-the-red-proof-reads-the-test-report-and-testsunchanged-compares-lines.md) (testsUnchanged loads)

## Context
The real brewer runner, `claudeBrewerRunner` (ADR 0047), runs an attempt from a plan: the worktree, the environment, the prompt, the `claude` call, the permissions, the settings file and the session. Nothing built that plan, so no attempt could run on it. Since #151 the Brewery's recipe files reach the engine (ADR 0053), and the brewer of each step is read and checked there. The plan needs that brewer and its instructions.

The driver asked for each attempt's limits by step id. Two batches may brew different recipes whose steps share an id, so the step id alone does not say which brewer limits the attempt.

The first run of a real step through the driver (#148) showed two gaps that the test fake hid. A recipe from the files is done after its last step with no pull request (ADR 0053), but `batch.on_tap` needed at least one, so the last step's finish was refused and the batch stayed brewing. And the real `Recipe` throws for a step id it does not have, so an attempt whose step was renamed in the file under its batch made every supervisor tick throw, and its end was never recorded (review of #151).

`foedrum serve` itself, its configuration and an end-to-end run through it are #162.

## Decision

### The plan
- `planAttempt` (`src/brewers/attempt-plan.ts`, the pure core) builds the plan from the brewer of the attempt's step:
  - **worktree**: the one the driver recorded in `step.started` (ADR 0037); an attempt without one is not planned;
  - **environment**: `buildBrewerEnv` over a base and forced variables the caller gives, with the brewer's `env` between them (ADR 0028);
  - **prompt**: the brewer file's body, then the out doc contract of brewers-and-recipes §2 naming `output.doc`, then the inputs through `assembleBrewerPrompt` (ADR 0041). `{name}` in the body is not replaced: the rule above the inputs says it refers to the inputs with that name. An input that holds the prompt's nonce refuses the plan;
  - **call**: the model id behind the brewer's alias in `models.jsonc` (the alias `models.jsonc` gives the brewer by name first; no model for the alias refuses the plan), `effort`, `maxTurns`, and as `--tools` the tool of each allow rule, once each;
  - **permissions**: the brewer's `tools.allow` with the repository's toolchain rules (`foedrum.jsonc`, ADR 0023), its `tools.deny`, and whether the isolation level relies on Claude Code's sandbox;
  - **settings file**: `<workRoot>/attempt-settings/<batch>/<step>/<attempt>.json`, outside the worktree, so the brewer neither sees it as a change nor edits it;
  - **session**: always a new one, with an id the plan chooses (ADR 0047). When a human answered the step's questions (`needs_input`), the answers of every round go after the inputs as one more tagged input, `answers to the questions of step <id>`, one `Q:`/`A:` pair each: ADR 0006's fallback of a fresh attempt with a `qa.md` in-doc, until a resumed session (#162) carries them instead.
- **Inputs.** `order` is the issue body of the batch's order, read through an injected source (the GitHub reads come with #162). `step:<id>` is the out doc of that step's latest attempt that succeeded, read in the worktree it ran in, which stays while the batch lives (ADR 0029); a step with none refuses the plan. `file:<path>` is a file of the attempt's worktree. Files are read as out docs are (`readOutDocFile`: a regular file, inside its worktree, one link, at most 1 MiB), and an order's text larger than 1 MiB refuses the plan too: anyone who can file an issue writes it.
- **The shell.** `createAttemptPlans` (`src/brewers/attempt-plans.ts`) finds the attempt's worktree in the driver's state and the brewer of its step in the batch's recipe, reads the inputs, makes the settings file's folder, and gives the plan. A plan it cannot make rejects, and the runner ends the attempt as a failure that is not retried (`the brewer could not start: …`, ADR 0028).
- **Limits per attempt.** The driver's `limits` takes the attempt, not its step id. `createAttemptPlans` answers with the out doc, `maxTurns` and `maxDenials` of the brewer of that batch's step. An out doc is read against the contract's schema: brewer-specific schemas (`output.schema`) are not built yet. An attempt whose step has no brewer gets the contract's out doc alone; its plan then fails it before anything runs.
- **The loader gives each step's brewer.** `loadRecipes` also returns the brewer of each step with its instructions (`StepBrewers`).

### What a brewer may ask for, for now
A step loads only when its brewer asks for nothing the plan does not carry. Otherwise it fails the load, one line each, as ADR 0053's refusals do: `step "<id>" has the brewer "<name>", with <what>, which the engine does not follow yet (ADR 0059)`, for `"retryMode": "resume"`, `"houseYeast": true`, `"skills"`, `"mcp"`, `"context": "repo"`, `"toolbox"`, `"doneWhen"`, and each guard but `requiresOutDoc`, which every attempt has anyway: the runner requires the out doc. `noPush` is refused too. Every attempt denies `git push` in each shell it allows, but that rule matches only a command that starts with the push (`git -C . push` gets past it), and the guard as brewers-and-recipes §1 describes it checks the remote after the attempt, which the engine does not do yet; a deny rule that also matches git's options before the push is #167. Resumed sessions come with #162; the others have no issue yet, and each takes its line out when the engine carries it.

### A step that left its recipe file
- The supervisor asks a recipe for a step's stall limit only when the recipe still has the step. A step without one has no stall limit, and its deadline still holds.
- An attempt of such a step that finishes, or is lost, is recorded, and the batch goes Stuck as `blocked` on a `divergence`: `recipe <name> has no step <id> any more: its file changed under the batch`. A human picks the way on (another recipe, a rewind, a cancel). A `retry` or `skip` of that step, which the Stuck lane offers as for any blocker, is refused with `recipe <name> has no step <id>`: `decide` schedules no step and goes on after none that its recipe does not have.

### On tap without a pull request
`batch.on_tap` may name no pull request. A recipe of brewer steps ends without one until the `openPullRequest` action lands; the claim of a target-repository issue is then released as `ended without a pull request` (ADR 0043), as `claimEffectsDue` already did.

## Consequences
- A driver brews a recipe from the Brewery's files with the real runner: `test/integration/attempt-plans.test.ts` runs one step from scheduled to on tap against the fake Messages API, opt-in with `FOEDRUM_REAL_CLAUDE=1` (ADR 0057).
- Brewers that ask for a resumed session, house yeast, skills, MCP servers, the repository's context, a toolbox, a definition of done or any guard but `requiresOutDoc` do not load yet. A Brewery that uses them sees why in `foedrum doctor`.
- Each step gets a new worktree from the base, so a later step does not see an earlier step's commits; how `tree: task` shares the task tree is open in #162.
- The settings files stay under the work root after their batch ends until #162 removes them with the batch's worktrees.
- `batch.on_tap`'s JSON Schema changes: an empty `pullRequests` is valid. Earlier events stay valid.
- ADR 0043's sentence that "`batch.on_tap` requires a pull request" is outdated; the release it describes already handled none.
- ADR 0047's consequence that "the engine does not build a plan yet" is outdated: this ADR builds it, and #162 connects it to `foedrum serve`.

## Alternatives considered
- **Let the plan drop the fields it does not carry.** The brewer would run without its MCP servers, skills or guards, as something it is not, which ADR 0053 refuses for step kinds for the same reason.
- **A step brewer lookup on the `Recipe` interface.** `decide` would see brewer files it does not need, and the test fake would have to grow them.
- **Limits from the plan, after the runner asked for it.** The driver gives the runner the limits before the plan is made, and the runner enforces them while the stream runs; a limit learnt from the plan would come too late for a plan that never resolves.
- **The settings file in the attempt's worktree.** The brewer could edit it (it is read once, at the start) and would see it as an untracked change of the repository.
- **Answer `undefined` from `stall` for an unknown step.** It would keep the tick alive, but the attempt's end would still throw in `decide`, and the batch would only be stopped by its deadline.
- **Keep `on_tap` needing a pull request and leave a done recipe brewing.** Its attempt has ended, so nothing would ever move it; it would sit silently until a human looked.
