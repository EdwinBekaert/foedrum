# 0063. `foedrum serve`: its configuration and wiring

Date: 2026-10-17 · Status: Accepted · Amends [0012](0012-worktrees-from-local-clones.md) (where `source` and the base are set), [0037](0037-attempt-worktrees-in-the-engine-and-driver-locks.md) (a driver over several repositories) , [0044](0044-batch-leases-held-by-the-driver-and-one-command-log.md) (`close()` stops the runs) and [0059](0059-attempt-plans-from-the-brewer-of-the-step.md) (where the order's text comes from, when the settings files go, and what it left open for #162)

## Context
Every piece of the Cellar exists: the driver lock and the work root's marker (ADR 0037), the state branch (ADR 0011, ADR 0024), the attempt worktrees (ADR 0029), the driver (ADR 0044), the recipe files (ADR 0053), the attempt plans and the real runner (ADR 0047, ADR 0059), and the GitHub reads (ADR 0052). Nothing sets them up from a Brewery's checkout and keeps them running. To do so, `foedrum serve` needs facts that no file holds yet: the Brewery's own `owner/name`, the work root, where each target repository's attempt worktrees come from and the base they start at, the models behind the brewers' aliases, and how to reach GitHub for the order's text.

Some of these facts belong to the Brewery and are the same on every machine (its name, a repository's base). Others belong to one machine (the work root, where the user's clone of a repository is). `foedrum.jsonc` is committed and shared, so it cannot hold the second kind.

#162 also asked two open questions: how `serve` gets an order into its batch's first step before the intake runs in its tick (#145), and how `tree: task` shares the task tree between the steps of a batch.

## Decision

### What the Brewery says, in `foedrum.jsonc`
- **`brewery`**: the Brewery's `owner/name` on GitHub. It names the work root's marker and driver lock (ADR 0037), the claims' records (ADR 0043) and the prefix of every pushed branch, and Brewery issues are read there. It is optional in the schema, so a config without it stays valid for `doctor`, but `serve` refuses to start without it.
- **`githubApi`**: the REST API's base URL, default `https://api.github.com`. It must be `https`, or `http` on a loopback address (a test's fake GitHub), since the token goes with every request.
- Per repository, **`source`**: `local` (default) or `managed` (ADR 0012), and **`base`**: the branch attempts start from, default `main`. Every attempt worktree starts at `origin/<base>` after a fetch.

### What the machine says, in `.foedrum/local.jsonc`
`.foedrum/` in the Brewery checkout is git-ignored and already holds the event store, so the machine's own facts go next to it, in `local.jsonc` (`LocalConfig`, `src/schemas/local-config.ts`; strict, read as JSONC). It is optional; without it every default applies.
- **`workRoot`**: an absolute path; on Windows with its drive or a UNC share, since `\work` lies on whichever drive serve runs on. Default `<home>/.foedrum/<owner>.<name>`, the Brewery's name in lower case as a path segment (`repoFolder`), short enough on Windows.
- **`clones`**: the absolute path of the user's clone of each target repository, by `owner/name`. A `local` repository needs one, or `serve` refuses to start naming it; a `managed` one borrows its objects when it has one (`--reference`).

### Where each repository's attempt worktrees come from
- `local`: worktrees of the clone `clones` names, in Foedrum's branch namespace (ADR 0012).
- `managed`: the bare partial clone at `<workRoot>/<owner>.<name>/clone.git`, made at the start of `serve` when missing, from `https://github.com/<owner>/<name>.git` (`ensureManagedClone`); git's credential helper answers for a private repository.
- **The repository a batch writes in**: a claimed issue's repository (`Batch.repo`), a sub-order's repository, or, for a Brewery order, the only repository of the Brewery. When a Brewery with several repositories has an order that is not decomposed, its attempt cannot get a worktree and fails retryably with `batch <id> names no repository, and the Brewery has <n>` (ADR 0037's path), so its attempts run out and it goes Stuck with that reason. A driver therefore takes a list of repositories, each with its base and worktree manager, and cleans all of them (`worktrees` in `DriverOptions`).

### `models.jsonc`
In the Brewery's root, read against `ModelsConfig`. `serve` refuses to start without it, or when a step's brewer names an alias it has no model for (one line per brewer), rather than failing that brewer's first attempt.

### GitHub and the order's text
- The token is `GH_TOKEN`, else `GITHUB_TOKEN`, as `gh` reads them; `serve` refuses to start without one. It never reaches a brewer: a brewer's base environment is an allowlist (below).
- The `order` input of a brewer is the body of the batch's issue, read through the GitHub reads of ADR 0052: `GET /repos/<repo>/issues/<n>` in the claimed issue's repository or the Brewery (`githubOrderText`, `src/github/order-text.ts`). A body GitHub answers as `null` is an empty text. A read that fails makes the plan fail, so the attempt fails without being retried (ADR 0059) and the batch goes Stuck with GitHub's reason; a human retries it.
- A brewer's base environment is `serve`'s own, kept to what a process needs to start and what `claude` needs to find its login: `PATH`, `PATHEXT`, `SYSTEMROOT`, `WINDIR`, `COMSPEC`, `TEMP`, `TMP`, `TMPDIR`, `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `SYSTEMDRIVE`, `PROGRAMFILES`, `PROGRAMDATA`, `HOMEDRIVE`, `HOMEPATH`, `USER`, `LOGNAME`, `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_GIT_BASH_PATH` and `ANTHROPIC_*`, compared as the platform compares names (`brewerBaseEnv`, `envNameKey`). None of them holds a secret but claude's own login. The runner forces `npm_config_ignore_scripts=true` (brewers-and-recipes §1.1).

### The wiring
`foedrum serve`, run in the Brewery's checkout, does in this order (`src/cli/serve.ts`, over the pure `serveSetup` in `src/cli/serve-config.ts`, on the machine through `serveShell` in `src/cli/serve-shell.ts`, which takes git as a parameter):
1. reads `foedrum.jsonc`, `.foedrum/local.jsonc`, `models.jsonc` and the recipe files, and stops with one line per problem, `doctor`'s line for recipes (ADR 0053), before it touches anything; a Brewery without a repository is one, since no attempt could get a worktree;
2. takes the driver lock `cellar` on the work root (`lockDriver`), which checks its Brewery marker;
3. opens the event store, `.foedrum/index.db`, making it when missing, and starts the state branch in `<workRoot>/state` (`openStateBranch().start()`), which rebuilds or catches up the store (ADR 0011, ADR 0024);
4. opens each repository's attempt worktrees (making a managed clone first) and the driver (`openDriver`, which repairs the worktrees, ADR 0037) with `claudeBrewerRunner`, the attempt plans and their limits (ADR 0059);
5. ticks the driver every 5 seconds, the supervisor's interval (ADR 0027), one tick after the other, and prints each notice as one line, its control characters escaped, since a model may have written it;
6. on a stop signal (`SIGINT`, `SIGTERM`, `SIGHUP` and `SIGBREAK`, through `stopOnSignals`; a brewer leads a process group of its own, which a closed terminal does not reach) stops ticking, waits for the tick underway, closes the driver and the store, and exits 0. It keeps listening for the signals until then (`listenWhileServing`), so a second Ctrl+C or a closed terminal during the wait cannot end the process before the driver stopped its runs. A `StateBranchStopError` from a tick stops it the same way and exits 1.

**`close()` stops the runs.** A driver's `close()` stops every brewer run it still has, then lets its lock go (moved here from #130). The runs' ends are not recorded: the next start of the same owner expires their leases (ADR 0033) and the supervisor loses and retries those attempts.

**Attempt settings files** go with the worktrees: the cleanup that removes an ended batch's worktrees also removes `<workRoot>/attempt-settings/<batch>/`, and the repair at a driver's start removes the folders of ended and unknown batches (`attemptSettingsCleaner`). A settings file is read once, when `claude` starts, so no live attempt needs it afterwards; a live batch keeps its folder anyway.

### A program, not a command of the command layer
`foedrum serve` runs until it is stopped; it is not an action a GitHub comment, the plugin or the dashboard could issue (ADR 0019). So it is not in the command registry, and a parity test between surfaces does not look for it: `runCli` hands it to the terminal's own `serve`, and `--help` lists it with the registry's commands.

### The open questions
- **How an order reaches its first step before the intake runs in `serve`'s tick (#145).** `serve` brews the batches its store has, Ordered and routed: those on the state branch it rebuilds from, and those a terminal command or an interactive session records. It neither polls nor routes; ordering labelled issues and routing them by their `recipe:<name>` label is the intake's, in the same tick, with #145. So the end-to-end test puts an order and its route on the throwaway Brewery's state branch, as an earlier driver would have, and `serve` brews it from there.
- **How `tree: task` shares the task tree between steps** needs a design of its own (a worktree from the previous step's tip, or one handed on, and what rewinds and claims do with it): #168. Until then each step gets a new worktree from the base, as today.
- **Resumed sessions** (`retryMode: resume`, ADR 0019, ADR 0029) change how the driver records and starts an attempt, the worktree claims and the plan, and are tested apart from `serve`: #169. Until then the loader refuses them by name (ADR 0059).

## Consequences
- A Brewery runs `foedrum serve` in its checkout with a `brewery` in `foedrum.jsonc`, a `models.jsonc`, a token, and the path of each local clone in `.foedrum/local.jsonc`.
- `foedrum.jsonc`'s JSON Schema gains `brewery`, `githubApi`, and `source` and `base` per repository; existing configs stay valid. `local.jsonc` has a zod schema of its own (`LocalConfig`) and no JSON Schema file: it holds a path and a map of paths, which editors need no help with.
- `DriverOptions.worktrees` is a list of repositories instead of one.
- `test/integration/serve.test.ts` runs `foedrum serve` as a process on a throwaway Brewery, against the fake Messages API and a fake GitHub, opt-in with `FOEDRUM_REAL_CLAUDE=1` (ADR 0057).
- No intake and no effects run in `serve` yet (#145, and the code host's `EffectTarget`); routing by label is #145's.
- `foedrum doctor` does not check `models.jsonc`, `local.jsonc` or the token yet; `serve` refuses with the same lines.
- GitHub Enterprise: `githubApi` reaches its API, but a managed clone's URL is always on github.com.

## Alternatives considered
- **The Brewery's name from the checkout's `origin` URL.** Remotes vary (ssh aliases, mirrors, local paths in tests) and a parse could silently name another repository; an explicit, schema-checked field cannot, and `doctor` can show it.
- **The work root and clones in `foedrum.jsonc`.** It is committed and shared: one machine's paths would be wrong on every other.
- **Environment variables for the work root and the clones.** A service started by systemd, launchd or Task Scheduler would need them in its definition; a file next to the store is found from the checkout alone.
- **The order and its route recorded by `serve` from a label before #145.** That is the intake's work, with its ETags, capacity and deadline (ADR 0052); doing a smaller copy of it here would leave two intakes to reconcile.
- **Pass the whole environment to brewers minus known secrets.** A denylist misses the secret nobody listed; the allowlist names what `claude` needs.
