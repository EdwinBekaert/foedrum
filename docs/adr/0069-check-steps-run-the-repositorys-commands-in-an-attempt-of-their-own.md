# 0069. Check steps run the repository's commands in an attempt of their own

Date: 2026-10-17 · Status: Accepted · Amends [0023](0023-language-independent-recipes.md) (how a missing or unstartable check is recorded), [0053](0053-recipe-files-reach-the-engine-brewer-steps-in-a-line-first.md) (check steps load) and [0064](0064-test-first-recipes-when-onblocked-and-a-red-proof-required.md) (`onFail` rounds)

## Context
A gravity reading is a deterministic check step in a recipe: `"check": "test"`, a list of named checks, or in a Brewery's own recipe a literal command (`{ "run": "…", "windows": "…" }`). The named checks (`build`, `typecheck`, `lint`, `format`, `test`) become commands through each repository's `checks` in `foedrum.jsonc`, where a check the repository lacks is `null` and is skipped, never guessed ([ADR 0023](0023-language-independent-recipes.md)). Recipes need one between a brewer that writes code and the pull request, but the loader refused every check step by kind ([ADR 0053](0053-recipe-files-reach-the-engine-brewer-steps-in-a-line-first.md)): the engine knew one kind of work, an attempt a brewer runner runs.

A check reads the commits of the steps before it. [ADR 0066](0066-the-task-tree-continues-from-the-latest-succeeded-attempt.md) already answers where they are: a check step is an attempt like a brewer's, with a worktree of its own at `taskTreeStart`, never an earlier attempt's worktree, which a check's build would change. [ADR 0064](0064-test-first-recipes-when-onblocked-and-a-red-proof-required.md) recorded `onBlocked` rounds on the schedule and left `onFail` for the engine running check steps. This decision is #177; the red proof (`"expect": "fail"`, read from the test report) stays with #176, which builds on it.

## Decision

### A check step is an attempt, run by the check runner
- **The driver does not change.** It schedules, starts, leases and finishes a check step's attempt as any other: under the attempt's lease, with a worktree at the task tree recorded in `step.started`, and with the supervisor's deadline, lost-lease and Stuck rules. `foedrum serve` hands it one runner, `stepRunner` (`src/engine/step-runner.ts`), which starts a check step's attempt on the **check runner** (`createCheckRunner`, `src/checks/check-runner.ts`) and every other on the claude runner. `loadRecipes` gives the checks of each check step (`StepChecks`, beside `StepBrewers`), and `serveSetup` each repository's `checks`.
- **No model, no tokens.** The check runner reads the attempt's worktree from the folded state and runs the step's checks one after another in it, through the process runner (`execProcess`): each command line through the platform shell (`shell: true`: `/bin/sh -c` outside Windows, cmd.exe by its full path with `/d /s /c` on Windows, with `NoDefaultCurrentDirectoryInExePath` set as for every cmd.exe start, ADR 0031), on Windows inside a kill-on-close Job Object (`jobObject: true`, ADR 0039), with the time left until the attempt's `deadlineAt` as its timeout, and an abort signal for the engine's stop. The process runner kills the whole tree at either, and at its output limit (4 MiB, ADR 0035). A command that runs a file in the worktree names it with its path (`./gradlew`, `.\gradlew.bat`): Windows does not look in the working directory.
- **Which command.** A named check takes the repository's command, its override for the platform (`windows`, `macos`, `linux`) or else its `run`; a `null` check is skipped without running anything; a literal command needs no repository entry. The repository is the one the attempt's worktree is in (`worktree.repo`), as `foedrum.jsonc` lists it.
- **Environment.** The brewers' environment (`brewerBaseEnv` and the runner's forced variables, ADR 0063): what a process needs to start, never the engine's GitHub token, and `npm_config_ignore_scripts=true`, which keeps npm's `pre`/`post` scripts out but still runs the script a command names (`npm test`).
- **A check's work is not handed on.** Its success moves the task tree to its own branch at the same commit (ADR 0066), so whatever a build left uncommitted in its worktree reaches no later step.

### What a check reads, and how the step ends
- **The first check that does not pass ends the step**, and the ones after it do not run: they would read a tree already known to fail, and the deadline covers the whole step. A check passes when it is skipped or exits with code 0.
- **Recorded on `step.finished`.** The finish carries `readings`, one per check that ran or was skipped, in order: `skipped` with the check's name; `exited` with the command line as it ran, its exit code and the tail of its output; `killed` with why the process runner killed it (`timed-out`, `stopped`, `too-much-output`) and the tail; `unstarted` with the tail, which holds the reason. A literal command's reading has no check name. The tail is the last 4,000 characters of stdout and stderr together, in the order they came, never starting with half a character: where a failing test shows, and small enough for the event log and the state branch. The fold keeps the readings on the attempt. `StepOutcome` stays the single contract (ADR 0005); the readings sit beside it, as `usage` does.
- **The outcome**, from the first reading that did not pass:

| Reading | Outcome | Then (ADR 0025) |
|---|---|---|
| every check passed or was skipped | `succeeded`, `output: null` | the next step |
| `exited` with another code | `failed`, not retryable: `the check "test" (npm test) failed with exit code 1` | the `onFail` route, else Stuck (`attempts_exhausted`) |
| `killed`, `timed-out` | `failed`, not retryable: `… did not finish by the step's deadline` | the same |
| `killed`, `stopped` | `cancelled` | another attempt, else Stuck |
| `killed`, `too-much-output` | `blocked`, `environment`: `… wrote more output than the process runner's limit` | Stuck at once |
| `unstarted` | `blocked`, `environment`: `… could not start: <the tail's last line>` | Stuck at once |

  A failed reading is not retryable: the same tree would read the same. An attempt that read nothing (its worktree could not be made, it was lost or cancelled) is tried again. The runner is also blocked, running nothing, by an attempt without a worktree (`environment`), a step that is no check step of the batch's recipe (`divergence`), and a named check of a repository that `foedrum.jsonc` does not list (`environment`).
- ADR 0023's "records the skip in the batch's events" is this `skipped` reading; the status comment shows it when status comments land.

### The recipe of a check step
- **The loader takes ADR 0053's refusal of check steps out.** A check step with `"expect": "pass"` (the default) loads, with a `when` that reads the recipe's settings as a brewer step's may (ADR 0064). Its `Recipe` answers:
  - its deadline: its own, else **30 minutes**, at most 365 days like any step's;
  - no stall limit: a check makes no progress the runner could see, and its deadline covers a hang;
  - another attempt while fewer than **3** of its attempts over the batch's life ended without a reading (cancelled, or failed retryably). Readings that failed do not count, so the rounds of an `onFail` route do not use up its retries;
  - its `onFail` route: `loopBack(batch, id, 'failed')` answers with the `goto` step while the route has been taken fewer than `maxRounds` times, counted from the `route` each attempt it scheduled records, `{ from, why: 'failed' }`, exactly as ADR 0064 counts `onBlocked` rounds. After that the batch is Stuck (`attempts_exhausted`) with the failed reading's reason. A route back to a skipped step is Stuck on a divergence, as for `onBlocked`. `decide` already took the route for a failure that was not retried; nothing in it changes.
- **The red proof is still refused**, by name, until #176 runs it: `step "<id>" is a red proof ("expect": "fail"), which the engine does not run yet (#176) (ADR 0069)`. Test-first recipes, which need one (ADR 0064), therefore still do not load.

## Consequences
- A recipe of a brewer step followed by `"check": "test"` brews in `foedrum serve`: a failing test sends the batch back along `onFail` or makes it Stuck with the command, its exit code and the tail of its output in the event log. `test/integration/attempt-worktrees.test.ts` runs a real command in a real worktree through `openDriver`.
- `step.finished` has an optional `readings`; existing logs and state branches still fold.
- A check costs a worktree like any attempt, and on Windows about 0.4 s for its Job Object.
- The repository's `setup` command (ADR 0023: run once per worktree) is not run yet, so a check whose command needs installed dependencies (`npm test` without `node_modules`) fails in a fresh worktree until setup lands. A check's own command can install them meanwhile (`npm ci && npm test`).
- A brewer sent back by `onFail` is not yet told why: the reading is in the event log, not in its prompt. Handing the failed reading to the step a route goes back to is a follow-up.
- A build that leaves untracked files makes its worktree one with changes, which the cleanup keeps until a human looks (ADR 0029). A repository whose checks write outside its `.gitignore` should ignore what they write.

## Alternatives considered
- **A `check.read` event of its own before `step.finished`.** One more event type, fold case, guard row and state-branch file for what the finish of the same attempt already says; two events where the kill could fall between them.
- **Run the check in the worktree of the step before it.** No extra worktree, but a build or a formatter changes that worktree, the brewer's attempt would share its folder with another process, and the task tree's rules (ADR 0066) would have an exception.
- **Run every check of the step, and fail if any failed.** More for a human to read, but a slower step on a tree already known to be broken; and the first failure is the one a brewer sent back would fix first.
- **Retry a failed check.** Flaky suites exist, but a retry would hide them and spend the step's deadline; a failed reading is a fact about the tree, and the route back or a human decides what follows.
- **Pass the command to the process runner as a program and arguments.** No shell, but the repository's commands are shell lines (`npm test -- --reporter tap`, `make e2e && make clean`) that `foedrum.jsonc` writes as one string; splitting them would invent a quoting language.
