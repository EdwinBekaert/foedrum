# 0062. Brewers never allow git with no fixed subcommand, and `noPush` still waits for the remote

Date: 2026-10-17 · Status: Accepted, amended by [0106](0106-the-nopush-guard-compares-the-remote-s-refs-around-each-attempt.md) (`noPush` loads: the engine checks the remote around each attempt) · Amends [0042](0042-the-claude-command-line-and-stream-contract.md) (the settings file's deny list), [0046](0046-only-the-runners-settings-the-init-check-and-a-line-by-line-stream.md) (what the settings may allow), [0057](0057-real-claude-tests-are-opt-in-and-claude-proofs-leave-the-suite.md) (the runner settings tests against `claude`) and [0059](0059-attempt-plans-from-the-brewer-of-the-step.md) (why `noPush` is refused)

## Context
Every attempt's settings deny `git push` in each shell the brewer has: `Bash(git push *)`, `PowerShell(git push *)` (ADR 0042). The review of #165 found that those rules match only a command that starts with the push. With a broad allow rule such as `Bash(git *)`, a model steered by untrusted text can push with git's own options in front of the subcommand: `git -C . push`, `git -c x=y push`, `git --git-dir=… push`. Pushing is always the engine's job (brewers-and-recipes §1). #167 offered two ways: a deny rule that also matches the options (`Bash(git * push*)`), or refusing a brewer whose allow rules reach git with no fixed subcommand, if no deny rule can cover every spelling. It also asked whether the `noPush` guard, which ADR 0059 refuses, can then load.

How claude reads the rules was checked against the installed `claude` 2.1.301 on Windows 11, through the fake Messages API of ADR 0057, with `--permission-mode dontAsk` and a settings file allowing `Read` and `<shell>(git *)`:

| Command | Deny rules | Bash | PowerShell |
|---|---|---|---|
| `git push origin` | `git push *` | denied | denied |
| `git -C . push origin` | `git push *` | **runs** | **runs** |
| `git -c x=y push`, `git --git-dir=.git push` | `git push *` | **runs** | **runs** |
| `git -C . push` (nothing after `push`) | `git push *`, `git * push *` | **runs** | — |
| `git -C . 'push' origin` | `git push *`, `git * push *` | **runs** | — |
| `git -C . 'push' origin` | `git push *`, `git *push*` | denied | — |
| `git -C . p''ush origin`, `git -C . p"u"sh` | `git push *`, `git *push*` | **runs** | — |
| `git p''ush` | `git push *` | **runs** in Bash | denied |

A Bash rule matches the command as written, quotes included: an empty quote pair inside the subcommand (`p''ush`), which the shell removes, gets past every pattern, so no deny rule covers every spelling. PowerShell rules are read from the parsed command, case-insensitively and with aliases resolved (docs: Permissions, PowerShell), so `p''ush` is denied there, but `git -C . push` still gets past `PowerShell(git push *)`.

Allowing only fixed subcommands (`<shell>(git status *)`, `<shell>(git commit *)`) denied every one of these spellings in both shells, and also `git commit -m x && git p''ush`, `git commit -m "$(git p''ush)"` and `& git -C . push`. In `dontAsk` mode a command that no allow rule matches is denied, so what holds is that no allow rule reaches the push. The PowerShell tool needs `CLAUDE_CODE_USE_POWERSHELL_TOOL=1` in a session without the user's settings (docs: Tools); without it a call is `No such tool available` and proves nothing.

## Decision
- **The second option.** A brewer's `tools.allow`, and the attempt settings the runner writes, refuse a shell rule that reaches git with no fixed subcommand (`BrewerAllowedTool`, `reachesAnyGitCommand` in `src/schemas/primitives.ts`). The check fails closed on the program word, the rule's first word:
  - a whole shell (`Bash`, `PowerShell`), or a star in or right after the program word (`Bash(*)`, `Bash(/*)`, `Bash(./*)`, `Bash(g*)`, `Bash(git*)`);
  - a program word with a quote, `&`, `# 0062. Brewers never allow git with no fixed subcommand, and `noPush` still waits for the remote

Date: 2026-10-17 · Status: Accepted · Amends [0042](0042-the-claude-command-line-and-stream-contract.md) (the settings file's deny list), [0046](0046-only-the-runners-settings-the-init-check-and-a-line-by-line-stream.md) (what the settings may allow), [0057](0057-real-claude-tests-are-opt-in-and-claude-proofs-leave-the-suite.md) (the runner settings tests against `claude`) and [0059](0059-attempt-plans-from-the-brewer-of-the-step.md) (why `noPush` is refused)

## Context
Every attempt's settings deny `git push` in each shell the brewer has: `Bash(git push *)`, `PowerShell(git push *)` (ADR 0042). The review of #165 found that those rules match only a command that starts with the push. With a broad allow rule such as `Bash(git *)`, a model steered by untrusted text can push with git's own options in front of the subcommand: `git -C . push`, `git -c x=y push`, `git --git-dir=… push`. Pushing is always the engine's job (brewers-and-recipes §1). #167 offered two ways: a deny rule that also matches the options (`Bash(git * push*)`), or refusing a brewer whose allow rules reach git with no fixed subcommand, if no deny rule can cover every spelling. It also asked whether the `noPush` guard, which ADR 0059 refuses, can then load.

How claude reads the rules was checked against the installed `claude` 2.1.301 on Windows 11, through the fake Messages API of ADR 0057, with `--permission-mode dontAsk` and a settings file allowing `Read` and `<shell>(git *)`:

| Command | Deny rules | Bash | PowerShell |
|---|---|---|---|
| `git push origin` | `git push *` | denied | denied |
| `git -C . push origin` | `git push *` | **runs** | **runs** |
| `git -c x=y push`, `git --git-dir=.git push` | `git push *` | **runs** | **runs** |
| `git -C . push` (nothing after `push`) | `git push *`, `git * push *` | **runs** | — |
| `git -C . 'push' origin` | `git push *`, `git * push *` | **runs** | — |
| `git -C . 'push' origin` | `git push *`, `git *push*` | denied | — |
| `git -C . p''ush origin`, `git -C . p"u"sh` | `git push *`, `git *push*` | **runs** | — |
| `git p''ush` | `git push *` | **runs** in Bash | denied |

A Bash rule matches the command as written, quotes included: an empty quote pair inside the subcommand (`p''ush`), which the shell removes, gets past every pattern, so no deny rule covers every spelling. PowerShell rules are read from the parsed command, case-insensitively and with aliases resolved (docs: Permissions, PowerShell), so `p''ush` is denied there, but `git -C . push` still gets past `PowerShell(git push *)`.

Allowing only fixed subcommands (`<shell>(git status *)`, `<shell>(git commit *)`) denied every one of these spellings in both shells, and also `git commit -m x && git p''ush`, `git commit -m "$(git p''ush)"` and `& git -C . push`. In `dontAsk` mode a command that no allow rule matches is denied, so what holds is that no allow rule reaches the push. The PowerShell tool needs `CLAUDE_CODE_USE_POWERSHELL_TOOL=1` in a session without the user's settings (docs: Tools); without it a call is `No such tool available` and proves nothing.

## Decision
- **The second option.** A brewer's `tools.allow`, and the attempt settings the runner writes, refuse a shell rule that reaches git with no fixed subcommand (`BrewerAllowedTool`, `reachesAnyGitCommand` in `src/schemas/primitives.ts`). The check fails closed on the program word, the rule's first word:
  - a whole shell (`Bash`, `PowerShell`), or a star in or right after the program word (`Bash(*)`, `Bash(/*)`, `Bash(./*)`, `Bash(g*)`, `Bash(git*)`);
 or an assignment (`Bash('git' *)`, `PowerShell(& git *)`, `Bash(GIT_DIR=.git git *)`), or in Bash a backslash, which quotes there (`Bash(g\it *)` runs git); in PowerShell a backslash stays a path separator;
  - a common wrapper that runs the rest of its line as a command (`env`, `command`, `exec`, `xargs`, `sudo`, `nice`, `nohup`, `time`, `timeout`, `npx`, `eval`, `source`, `iex`, `Start-Process`, and the shells) with a star, or with git after it (`Bash(env git *)`, `Bash(xargs *)`); without either it stays allowed (`Bash(npx tsc)`, `Bash(bash ./build.sh)`). This list is known to be incomplete (below);
  - git's own programs, `git-<name>`, with a star, or one that pushes (`Bash(git-send-pack *)`, `Bash(/usr/lib/git-core/git-push origin)`);
  - git, by name or by a path whose last part is `git`, or `git` with an extension Windows runs (`git.exe`, `git.cmd`, `git.bat`, `git.com`) (`Bash(/usr/bin/git *)`, `PowerShell(C:\Git\cmd\git.exe *)`, `PowerShell(git.cmd *)`), with an option, a quote or a star where the subcommand would be (`Bash(git *)`, `Bash(git -C *)`, `Bash(git -C . push)`), or with a subcommand that pushes or that a star could make into one: `push`, `send-pack`, `http-push`, `subtree` (`subtree push`) and `submodule` (`submodule foreach` runs commands), as in `Bash(git push *)`, `Bash(git p*)`, `Bash(git s*)`.

  Case does not count, leading spaces are dropped, and `:*` is read as ` *`. A fixed subcommand followed by a star stays allowed, as in the example brewer (`Bash(git commit*)`), and so does a program by another name or path (`Bash(npm run *)`, `Bash(./gradlew *)`).
- **What it closes, and what it cannot.** The check closes git's own spellings of a push: options before the subcommand, a quoted, escaped or computed program word, git by path or shim, git's own programs, and the subcommands that push. It cannot close a rule that runs a command given on its own line, because that command is any command:
  - programs: `npm exec` and `npm x` (so `Bash(npm *)`), `pnpm dlx`, `yarn exec`, `bunx`, `node -e`, `python -c`, `find -exec`, `wsl`, `xcrun`, `arch`, PowerShell's `start`, `saps`, `Invoke-Command` and `icm`;
  - git subcommands: `rebase -x`, `bisect run`, `fetch`, `pull` and `clone` with `--upload-pack`, `difftool -x`, `mergetool`, `filter-branch`;
  - and what an allowed command runs in turn: the scripts behind `npm test` that a writing brewer can edit, the hooks `git commit` runs, an alias an allowed `git config` defines.

  The wrapper and subcommand lists do not grow to chase these. No list would be complete, and refusing every program that can run a command would refuse most toolchains. The control that holds for every spelling is on the remote (#173).
- **Where.** The brewer schema refuses such a brewer when it is loaded, so `foedrum doctor` names the rule. The attempt settings schema refuses it too, so the repository's toolchain rules (`foedrum.jsonc`, ADR 0023), which join the allowlist only in the plan, cannot add it either: that attempt fails with `the brewer could not start` (ADR 0059). The permission ceiling (`foedrum.jsonc`'s `permissionCeiling`) is not an allowlist and keeps `Bash(*)`.
- **The deny rules stay.** No allow rule can reach `git push` now, so `Bash(git push *)` and `PowerShell(git push *)` are a second line, in case the allow check is loosened later, and the settings schema still requires them (ADR 0046). No `git * push *` rule is added: with no allow rule that reaches a push, it would never be the rule that denies.
- **`noPush` still waits for the remote.** The guard stays out of `ENFORCED_GUARDS` (`src/engine/recipe-files.ts`), and a brewer that names it still fails the load (ADR 0059), because of what the check cannot close (above). brewers-and-recipes §1 describes the guard as a check that the branch did not move on the remote after the attempt. It loads with #173: the engine records the remote's refs before each attempt and compares them after it, and brewers may get no push credentials, so a push fails however it is spelled. (Since [0106](0106-the-nopush-guard-compares-the-remote-s-refs-around-each-attempt.md) it loads: the engine lists the remote's refs before and after each attempt of a brewer that names it, and a ref the engine did not write that changed makes the batch Stuck; the credentials are #299.)
- **Verified, not assumed.** `test/integration/claude-runner-settings.test.ts` runs four of the spellings above, `git -C . push`, `git -c x=y push origin`, `git --git-dir=.git push` and `git p''ush`, through the settings `writeAttemptSettings` writes for a brewer allowed `git status *` and `git commit *`, and expects a denial each time. As a control, `git status` runs under the same settings. Bash everywhere, PowerShell on Windows; opt-in with `FOEDRUM_REAL_CLAUDE=1`. These tests join the two runner settings tests that ADR 0057 kept. Like them, they check the file Foedrum writes (that no allow rule in it matches a push), not a feature of `claude` that the runner does not rely on: a `claude` that matched rules differently would break Foedrum's guarantee, and these tests are there to show it.

## Consequences
- A brewer file with `Bash(git *)`, `Bash`, `PowerShell`, a path to git with a star, or a wrapper with a star in `tools.allow` no longer loads. A brewer names the git subcommands it needs, and the programs it runs.
- Failing closed also refuses some harmless rules, such as `Bash(npm*)` (a star in the program word) or `Bash(FOO=1 npm test)` (an assignment): write `Bash(npm test)` or `Bash(npm run *)` (not `Bash(npm *)`, which reaches `npm exec`), or set the variable in the brewer's `env`.
- ADR 0042's line that the deny rule "only cuts down on attempts" still describes the deny rule; what denies a push in another spelling is now the allowlist.
- ADR 0059's reason for refusing `noPush` changes: not the deny rule any more, but the missing check of the remote, #173.
- The rule check is a guard against a broad allowlist, not a sandbox: anything an allowed command runs in turn is out of its reach, which is why the isolation level and the check of the remote stay.

## Alternatives considered
- **A deny rule for options before the subcommand** (`Bash(git * push*)`, `Bash(git *push*)`): the check above shows that quotes inside the subcommand get past any Bash pattern, and that `git * push *` misses a push with nothing after it.
- **Many deny rules, one per spelling found:** an arms race with the shell's quoting; each new spelling would be found after it was used.
- **Load `noPush` now:** it would claim a guard the engine does not hold, since a push through a script or a hook needs no command claude can match.
- **Grow the wrapper and subcommand lists until they hold:** every review round found more programs and subcommands that run a command (#170); the lists would never be complete, and each would refuse more ordinary rules. The remote check (#173) holds for all of them.
- **Refuse only `Bash(git *)` and whole shells:** `Bash(git -C *)` or `Bash(git p*)` reach the push just as well.
