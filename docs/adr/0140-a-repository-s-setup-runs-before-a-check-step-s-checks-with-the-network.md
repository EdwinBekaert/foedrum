# 0140. A repository's setup runs before a check step's checks, with the network

Date: 2026-10-22 · Status: Accepted · Amends [0063](0063-foedrum-serve-its-configuration-and-wiring.md) (serve's repositories carry their setup, and its shell a second process runner) and [0069](0069-check-steps-run-the-repositorys-commands-in-an-attempt-of-their-own.md) (a check step's first reading may be its setup's)

## Context
A target repository's entry in `foedrum.jsonc` can name a `setup` command with a `timeout` (`src/schemas/brewery-config.ts`, [ADR 0023](0023-language-independent-recipes.md): "run once per worktree"), for example `npm ci` or `dotnet restore`. Nothing ran it. Every attempt has a worktree of its own at the task tree ([ADR 0066](0066-the-task-tree-continues-from-the-latest-succeeded-attempt.md)), so a check step's worktree is fresh and holds no installed dependencies. Since [ADR 0076](0076-check-steps-run-in-an-os-sandbox-with-no-network.md) a check runs with no network, so its own command cannot install them either: `npm test` without `node_modules` fails in every fresh worktree (#349).

## Decision

### When it runs: before a check step's checks, in its worktree
- **Only before check steps, not before every attempt.** The check runner (`createCheckRunner`, `src/checks/check-runner.ts`) runs the setup of the attempt's repository (`worktree.repo`) once, in the attempt's worktree, before the step's first check, red proofs included; a repository without `setup` runs none. Why not before a brewer step too:
  - A check step is what cannot install: it has no network (ADR 0076). A brewer reaches the allowed network in its own sandbox and has its repository's toolchain rules (`tools`, ADR 0023), so it installs what it needs, where it needs it, inside that sandbox.
  - Setup runs code outside every sandbox (below): package managers run scripts, and a later step's worktree holds a manifest a brewer may have changed. Running it before every brewer attempt as well would run that code more often for no step that needs it.
  - Every attempt is a fresh worktree, so "once per worktree" before brewer steps would be once per brewer attempt: a full install before each, retries and `onFail` rounds included, whether the brewer runs the tests or not.
  - The driver does not change: setup is part of what a check step's attempt does, within its lease, deadline and stop (ADR 0069).
- The schema's description of `setup` changes to say so: `Runs in a check step's worktree before its checks, with the network (ADR 0140)`.

### How it runs
- **The check runner's process handling, without its sandbox.** The command line is the setup's `command` for the platform (`commandLine`, as a check's: its `windows`, `macos` or `linux` override, else `run`), started through the platform shell (`shell: true`), on Windows in a Job Object (`jobObject: true`), in the worktree, with the check's abort signal for the engine's stop and the process runner's output limit (4 MiB, ADR 0035), which kills the whole tree at either and at the deadline.
- **Its deadline** is the setup's `timeout`, or the time left until 10 seconds before the attempt's deadline when that is sooner (ADR 0069's margin), at least a millisecond.
- **With the network.** An install needs the registry, so setup does not go through `sandboxedChecks` (ADR 0076): `serve`'s shell gives the wiring a second process runner, `ServeShell.setup`, which is `execProcess` itself, and the check runner takes it as `setup.exec` beside `exec`. Its reading says `"unsandboxed": true` on every platform.
- **The brewers' minimal environment**, the one checks get (ADR 0069): `brewerBaseEnv` without claude's login and settings, and the runner's forced variables. That includes `npm_config_ignore_scripts=true`, so `npm ci` installs without running packages' install scripts; a dependency that needs one (a native build) does not work in check steps until a repository's setup runs it by name.

### What it reads, and how a failure ends the attempt
- **A reading like a check's**, first in the step's `readings`, with `"setup": true` beside the command line as it ran and the tail of its output, secrets left out as ADR 0069 says. A setup that exits 0 is recorded too, so the event log shows that it ran; the checks follow.
- **A setup that does not pass ends the attempt**, and no check runs, as an environment failure: `blocked`, `environment`, with the setup's command and why, and its tail in the reading:

| Reading | Outcome |
|---|---|
| `exited` 0 | the checks run |
| `exited` with another code | `blocked`, `environment`: `the setup "npm ci" failed with exit code 1` |
| `killed`, `timed-out` | `blocked`, `environment`: `the setup "npm ci" did not finish within its timeout or the step's deadline` |
| `killed`, `too-much-output` | `blocked`, `environment`: `the setup "npm ci" wrote more output than the process runner's limit` |
| `signaled` | `blocked`, `environment`: `the setup "npm ci" was ended by SIGKILL` |
| `unstarted` | `blocked`, `environment`: `the setup "npm ci" could not start: <the tail's last line>` |
| `killed`, `stopped` | `cancelled`, as a check's stop |

  A failed setup is no fact about the tree under check: a check's failure routes along `onFail`, which would send a brewer back to fix code that is not wrong. It is a fact about the machine, the registry or the manifest, which a human looks at; so the batch is Stuck at once with the reason (ADR 0025).

### No sandbox for setup, in this decision
Setup runs as the Cellar's user, with the network and the home folder, on every platform. What it runs can be code a brewer influenced (a changed manifest, a package's script when ignore-scripts is off by a repository's own setup line). Whether that needs a registry-only sandbox waits for proof under CLAUDE.md's safeguard rule: an observed case, or a path the brewers' sandbox and the checks' no-network sandbox (#190) do not already cover. No row of `docs/trust-boundaries.md` changes.

## Consequences
- A recipe whose check step runs `npm test` brews in a fresh worktree when its repository's setup is `npm ci`; ADR 0076's "a check that needs installed dependencies fails until #349" no longer holds.
- Every check step's attempt pays one setup, also a red proof's, the check after a brewer and each `onFail` round's. A repository whose installs are slow sets a cache its setup reuses (npm's own cache under the home folder is used, since setup runs outside the sandbox).
- `step.finished`'s readings may carry `setup`; existing logs and state branches still fold.
- `ServeShell` has one more process runner, and the fakes that build one (tests, the demo) give it.
- A brewer that needs installed dependencies still installs them itself, within its sandbox and toolchain rules.

## Alternatives considered
- **Before every attempt's first step, in the driver.** What the schema's description said. It costs an install per brewer attempt, runs unsandboxed code before steps that do not need it, and puts a process start in the driver, which today only makes worktrees.
- **Through the check sandbox with the network opened to the registry.** That is the registry-only sandbox the issue leaves for when there is proof; it needs a proxy or per-ecosystem host lists.
- **A failed setup as a failed check, along `onFail`.** It would send a brewer to fix a tree whose install failed on the machine's side.
- **No reading for a setup that passed.** Smaller events, but no trace that setup ran, or of what it printed, when a check after it fails strangely.
