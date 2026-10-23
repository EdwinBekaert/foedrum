# 0163. A repository's setup runs before a fresh brewer attempt

Date: 2026-10-23 · Status: Accepted · Amends [0140](0140-a-repository-s-setup-runs-before-a-check-step-s-checks-with-the-network.md) (setup runs before a fresh brewer attempt too, not only before check steps) and [0158](0158-a-repository-s-setup-runs-in-the-check-sandbox-with-the-network-kept.md) (`serveSetup` refuses a sandboxed minimum with a setup without a check step too, and on native Windows with its own line)

## Context
A brewer works in an attempt worktree of its own, at the task tree, with the tool rules of its brewer file plus its repository's `tools` within the Brewery's `permissionCeiling` ([ADR 0026](0026-how-a-permission-ceiling-covers-a-rule.md)). Since [ADR 0140](0140-a-repository-s-setup-runs-before-a-check-step-s-checks-with-the-network.md) a repository's `setup` (`npm ci`, `dotnet restore`) runs only in a check step's worktree. A brewer's worktree has no installed dependencies, so even a `tools` rule that allows `npm run lint` could not run it, and the default Cellarman's prompt said it need not run lint or format.

ADR 0140 expected a brewer to install what it needs itself. None did: every trial's Gauger and Cellarman wrote code blind. Batch `7-1` (#431, the second order Foedrum brewed on itself) shows the cost. Green #1 failed on the typecheck, implement #2 fixed it but left one line the formatter would split, and green #2 failed on lint. Nip gives green one round back (`maxRounds: 1`), so the batch went Stuck on a nit `npm run lint` would have shown the brewer in seconds (#432).

## Decision

### Setup runs before a fresh brewer attempt
- **Where.** The plan of a brewer attempt that starts fresh (`createAttemptPlans`, `src/brewers/attempt-plans.ts`) carries its repository's `setup`: the command line for the platform and its timeout (`setupRunOf`, `src/checks/setup.ts`), the attempt's deadline, and the checks' environment (`checksEnv`: the brewers' minimal base without claude's login, with the runner's forced variables, so `npm_config_ignore_scripts=true`, ADR 0069). The brewer runner (`claudeBrewerRunner`) runs it in the attempt's worktree after the plan and before claude starts.
- **How.** Exactly as before a check step (ADR 0140, ADR 0158), through the same function (`runSetup`): the platform shell, a Job Object on Windows, the setup's process runner, which is the check sandbox with the network kept (`ServeShell.setup`); on native Windows no sandbox, and the reading says `unsandboxed`. It is killed at its `timeout`, or 10 seconds before the attempt's deadline when that is sooner, or at the attempt's stop.
- **Not for a resumed attempt.** An attempt that resumes a session (a retry or an answered attempt, [ADR 0117](0117-a-retry-resumes-the-session-of-the-attempt-before-it-in-that-attempt-s-worktree.md)) runs in the worktree of the attempt that started that session, whose setup already ran, so its plan carries none. That attempt's claude started, so its setup passed. A foreground session `foedrum resume` continues (ADR 0127) is such an attempt too; a fresh attempt it runs goes through the headless runner and gets its setup.
- **Its reading.** The setup's reading goes on the attempt's `step.finished` as `readings`, as a check step's does, with `"setup": true`. A setup that passed is recorded too, beside claude's report.

### A setup that does not pass ends the attempt before any model tokens
ADR 0140's table applies as it is: a non-zero exit, a kill at the timeout, too much output, a signal, or a setup that could not start (its sandbox included) ends the attempt `blocked`, `environment`, with the setup's command and why, and its reading; a stop during setup ends it `cancelled`. claude never starts, so no token is spent. A runner given a plan with a setup and no process runner for it reads the setup as unstarted, with that reason.

### The default Gauger and Cellarman run the repository's checks themselves
- The Cellarman (version 3) runs the repository's formatter on the files it changed, then its lint and typecheck, then the tests that cover the code it changed, and fixes what they find before it commits. The Gauger (version 3) does the same for the files it wrote, then runs its new tests and checks that each fails for the right reason.
- Each runs only what its tools allow, and does not try a denied command again: a denial counts toward `maxDenials`. A Brewery allows them through a repository's `tools`, within the ceiling (`docs/design/recipes/configuration.md` shows Foedrum's own: `npm run lint`, `npm run typecheck`, `npx biome format --write <path>`, `node --test <file>`).
- **The check step stays the gate.** What the brewer ran is no reading; green and the red proof run every check after it, as before.

### serve refuses a sandboxed minimum with a setup without a check step too
ADR 0158 refuses `serve` when a Brewery requires the sandboxed level, a recipe has a check step and a repository has `setup`, on Linux and WSL2, since the setup's sandbox reaches the host's abstract Unix sockets until #425. Now every recipe's brewer steps run the setup, so the check step drops out of the condition. On native Windows a setup has no sandbox; ADR 0158 left its line out because the checks' refusal ([ADR 0076](0076-check-steps-run-in-an-os-sandbox-with-no-network.md)) already stopped the same Brewery, but that refusal needs a check step. Without one, the setup now gets a line of its own: `foedrum.jsonc requires the sandboxed isolation level, and <repo>'s setup runs outside a sandbox on native Windows (ADR 0163)`. This is ADR 0140's refusal applied to the steps setup now runs before, not a new guard.

### What it costs, and why each worktree installs its own
- **Per attempt, measured on Foedrum's own repository** (Windows 11, `npm ci` from `package-lock.json`): 8 s with an empty cache, downloading 37 MB, and 5 s with a warm one; `node_modules` takes 116 MB of disk. In the sandbox the cache is the sandbox's empty home (ADR 0158), so every setup outside native Windows pays the empty-cache cost. The disk stays until the batch's worktrees are cleaned when it ends.
- So a Nip batch of one round pays two more setups than before (gauge and implement), each about 10 s, against a brewer attempt of minutes and a round back through green that costs a whole Cellarman attempt.
- **No reuse between steps.** A later step's worktree does not reuse an earlier one's install, and a check step does not reuse a brewer's:
  - The earlier install is a folder a brewer could write: a check that ran on it would read what that brewer left there, not what the manifest installs, and the gate would no longer be the repository's own (#190's path).
  - A later step's manifest may differ: the brewer before it may have changed `package.json`.
  - Sharing needs a folder outside the worktrees, linked or copied in, which ADR 0158 already declined for package caches, and cleanup that knows which batch still uses it.

  The simplest correct rule is one install per worktree, as ADR 0023 first said. A repository whose installs are slow names a cache in its own setup line (ADR 0158).
- **The repository ignores what setup writes.** A brewer commits its worktree; `node_modules` is not committed only because the repository's `.gitignore` names it, as every npm repository's does.

### Security
Setup ran unsandboxed code a brewer may have influenced before check steps; it now also runs before brewer steps, in the same sandbox with the same environment, so no row of `docs/trust-boundaries.md` gains a risk: the row "A check step running code a brewer wrote" names both places. The commands the brewer runs itself (`npm run lint`, `node --test`) run code it may have written, in its own sandbox where the isolation level has one, as `npm test` in a repository's `tools` always did ([ADR 0082](0082-brewers-never-allow-gh.md), "What the rules cannot close"). No safeguard is added.

## Consequences
- A brewer finds the repository's dependencies in its worktree, and with the tools allowed runs format, lint, typecheck and the tests it touches before it commits; a formatting nit no longer costs a round back through green.
- Every fresh brewer attempt of a repository with `setup` pays one install, retries and `onFail` rounds included; a resumed attempt pays none.
- A brewer attempt's `step.finished` may carry `readings`, the setup's; existing logs and state branches still fold.
- A broken install (a registry outage, a bad lock file) now ends the first brewer attempt, not the first check step, so the batch is Stuck before any tokens are spent.
- `foedrum serve` refuses a Brewery that requires the sandboxed level and has a repository with `setup` on Linux, WSL2 and native Windows, with or without a check step.
- `ServeShell.runner` passes its setup's process runner to the claude runner, and `interactiveBrewerRunner` takes one for its headless attempts.

## Alternatives considered
- **The brewer installs its dependencies itself (ADR 0140).** None did in any trial, and an install needs the registry and a `tools` rule for it, under which it runs in the brewer's shell, outside the check sandbox ADR 0158 gave setup.
- **Setup in the driver, when it makes the worktree.** One place for all steps, but a process start in the driver, and a check step and a brewer each need its reading on their own `step.finished`.
- **Setup before every attempt, resumed ones too.** Correct, but a resumed attempt's worktree already has its install, and it would cost an install per retry for nothing.
- **Reuse an earlier step's install** (a link or copy of `node_modules`). Faster, but see above: the gate would read a folder a brewer could write.
- **A failed setup as a failed attempt that is retried.** A registry or lock-file failure meets the next attempt again; ADR 0140's environment block lets a human look.
