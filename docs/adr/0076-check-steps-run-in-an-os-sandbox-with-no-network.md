# 0076. Check steps run in an OS sandbox of Foedrum's own, with no network

Date: 2026-10-22 · Status: Accepted · Amends [0069](0069-check-steps-run-the-repositorys-commands-in-an-attempt-of-their-own.md) (checks no longer run outside the OS sandbox), [0010](0010-cross-platform-and-isolation-levels.md) (the minimum level's first use; bubblewrap for check steps on Linux) and [0031](0031-cmd-and-bat-files-through-cmd-exe.md) (a check's line reaches `/bin/sh -c` as arguments of the sandbox) · Amended by [0140](0140-a-repository-s-setup-runs-before-a-check-step-s-checks-with-the-network.md) and [0142](0142-a-macos-check-may-stat-the-folders-above-its-worktree-in-the-home-folder.md)

## Context
A gravity reading runs a repository's command line (`npm test`, `make`) in an attempt worktree of its own (ADR 0069). What that line runs is code an earlier brewer may have written: `npm test` runs the worktree's `package.json` script, which a brewer steered by an injected issue can change. ADR 0069 ran it as the Cellar's user, with the network and the home folder, and said so in one line at `foedrum serve`'s start. Since [ADR 0073](0073-github-only-through-gh-s-own-login.md) the maintainer's GitHub login lives in `gh`'s keyring, so such a script could run `gh auth token` or `gh api` and act as the maintainer (#190).

Brewers at the `sandboxed` level ([ADR 0010](0010-cross-platform-and-isolation-levels.md)) run their shell commands in Claude Code's sandbox, which is bubblewrap on Linux and WSL2 and Seatbelt on macOS. A check runs no `claude`, so it cannot borrow that sandbox; Anthropic's `@anthropic-ai/sandbox-runtime`, which Claude Code's is built on, was weighed and left (Alternatives).

The tools' own documentation, read for this ADR on 2026-10-22:

- **bwrap(1)** ([Debian bookworm](https://manpages.debian.org/bookworm/bubblewrap/bwrap.1.en.html)): bwrap "works by creating a new, completely empty, filesystem namespace where the root is on a tmpfs"; filesystem options "are applied in the order they are given as arguments"; `--ro-bind` "Bind mount the host path SRC readonly on DEST", `--bind` the same writable, `--tmpfs` "Mount new tmpfs on DEST", `--dev` "Mount new devtmpfs", `--proc` "Mount procfs", `--chdir` "Change directory to DIR", `--setenv` "Set an environment variable", `--unshare-net` "Create a new network namespace", `--die-with-parent` "Ensures child process (COMMAND) dies when bwrap's parent dies", `--new-session` "Create a new terminal session for the sandbox (calls setsid())"; and "The bwrap command returns the exit status of the initial application process".
- **sandbox-exec(1)** ([Xcode man pages](https://keith.github.io/xcode-man-pages/sandbox-exec.1.html)): `sandbox-exec [-f profile-file] [-n profile-name] [-p profile-string] [-D key=value ...] command [arguments ...]`; `-p` "Specify the profile to be used on the command line", `-D` "Set the profile parameter key to value". The page says "The sandbox-exec command is DEPRECATED".
- **The profile language** (SBPL) has no manual page of Apple's. Its forms here, `(version 1)`, `(allow default)`, `(deny network*)`, `(deny file-write*)`, `(allow file-read* (subpath …))`, `(deny mach-lookup (global-name …))`, `(param "KEY")` for a `-D` value, and the later rule winning over an earlier one, are those [`sandbox-runtime`](https://github.com/anthropics/sandbox-runtime/blob/main/src/sandbox/macos-sandbox-utils.ts) writes for Claude Code's own sandbox on macOS, which starts `/usr/bin/sandbox-exec -p <profile> <shell> -c <command>`. That profile also allows `(global-name "com.apple.SecurityServer")`, the Keychain's service: the answer ADR 0087 left open for brewers' commands on macOS is that they can ask it.

We test our wrapper's arguments and profile, and in `test/integration/` that a real run keeps the three things out; not whether bwrap or Seatbelt work.

## Decision

### Where it runs
| Platform | A check's command line starts as |
|---|---|
| Linux, WSL2 | `bwrap <arguments below> /bin/sh -c <line>`, bwrap found on the Cellar's `PATH` |
| macOS | `/usr/bin/sandbox-exec -D … -p <profile below> /bin/sh -c <line>` |
| Native Windows | as before: cmd.exe through `shellCommand` in a Job Object (ADR 0069, ADR 0039) |

- **The wrapper is a process runner** (`sandboxedChecks`, `src/platform/check-sandbox.ts`): `serve`'s shell hands the check runner a runner that starts each command line through the sandbox and otherwise passes the call to `execProcess`, so the deadline, the stop, the output limit and the tree kill (ADR 0035) are the same. The arguments are built by pure functions (`bwrapArgs`, `seatbeltArgs`), tested with a fake runner.
- **Never unsandboxed outside Windows.** On Linux and macOS a check whose sandbox cannot start (no `bwrap` on `PATH`, no `/usr/bin/sandbox-exec`) does not run: it reads `unstarted` with the reason, and the step is blocked on its environment (ADR 0069's table). ADR 0010's permissions-only Linux (bubblewrap or socat missing, WSL 1) therefore needs bubblewrap for check steps; `foedrum doctor` already asks for it. Where the sandbox itself fails before the command line runs (WSL 1, or a kernel or AppArmor rule against unprivileged namespaces, where bwrap cannot make its namespaces; a sandbox-exec that cannot apply its profile), the tool says so on stderr under its own name (`bwrap: …`, `sandbox-exec: …`) and exits non-zero: that run is read as `unstarted` with the tool's message, never as a failed check. A check that prints such a line itself only blocks its own step. So does a home folder, worktree or temporary folder that cannot be resolved or made.
- **Native Windows** has no sandbox for shell commands (ADR 0010), and brewers there are not OS-sandboxed either, so a check adds no new reach. It runs as ADR 0069 says, and each reading of a command that ran says `"unsandboxed": true`, so the event log and the state branch show it to whoever reads them without knowing the Cellar's platform (`foedrum replay`, a reviewer of the state branch). `foedrum serve`'s start line about checks outside the sandbox now prints only on native Windows: `check steps run outside an OS sandbox on native Windows: their commands can run code a brewer wrote, with network and home-folder access (ADR 0076)`.
- **A Brewery that requires the sandboxed level** (`"isolation": { "minimum": "sandboxed" }` in `foedrum.jsonc`, ADR 0010) and has a check step does not start serve below it: `serveSetup` refuses with `foedrum.jsonc requires the sandboxed isolation level, and check steps would run at permissions only (<doctor's why>) (ADR 0076)`. It is the first use of the key: ADR 0010's refusal of writing brewers below the minimum is not built yet, and is not this decision's. The key takes `sandboxed` and `permissions only`, the levels doctor finds; the container level joins it when Foedrum runs brewers in containers.

### Linux and WSL2: bwrap
In this order, since bwrap applies them in order:

| Argument | Why |
|---|---|
| `--die-with-parent --unshare-pid --new-session` | A kill of bwrap, which the runner kills, ends the sandbox; with a pid namespace every process the check started ends with its first; no terminal to inject into |
| `--unshare-net` | No network: a namespace of its own with no interface to the host's |
| `--ro-bind / /` | The system read-only: compilers, interpreters and the libraries they load |
| `--dev /dev --proc /proc` | A device and process tree of the sandbox's own |
| `--tmpfs /tmp --tmpfs /run` | A writable temporary folder that goes with the sandbox, and `/run` hidden: it holds the user's D-Bus socket (`/run/user/<uid>/bus`), through which the Secret Service hands out gh's login, and on WSL2 the interop socket that starts Windows programs outside the sandbox. A socket on a read-only bind can still be connected to, so hiding is what closes it. A system that keeps its programs under `/run` (NixOS's `/run/current-system`) does not suit check steps |
| `--tmpfs <home>` | The home folder hidden, replaced by an empty writable one that goes with the sandbox: tools that write a cache under `~` still run |
| `--ro-bind <git dir> <git dir>` | The worktree's repository, read-only, when the worktree's `.git` file names a record `<repository>/worktrees/<name>` whose `gitdir` file names that `.git` back, compared as real paths (git records the real one; serve may name the worktree through a link, as where `/home` links to `/var/home`): git commands in a check read the history (the clone sits under the work root, often in the home folder). A check writes its worktree, `.git` included, so without the record's answer a check could name the home folder or `/run` for a later check of the step to have bound in (review of #357); git writes the record, outside every check's reach |
| `--bind <worktree> <worktree>` | The worktree writable, last, so it is mounted over the hidden home it may sit in |
| `--chdir <worktree> --setenv TMPDIR /tmp` | Start in the worktree; temp files in the sandbox's `/tmp` |

The paths are real paths (`realPath`), so a linked work root is bound where the kernel finds it.

### macOS: sandbox-exec
One profile for every check, with the paths as parameters (`-D`), never written into the profile, so no character in a path can change it:

```
(version 1)
(allow default)
(deny network*)
(deny mach-lookup (global-name "com.apple.SecurityServer"))
(deny job-creation)
(deny lsopen)
(deny appleevent-send)
(deny mach-lookup (global-name "com.apple.coreservices.launchservicesd"))
(deny file-write*)
(allow file-write* (subpath (param "WORKTREE")) (subpath (param "TEMP")) (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr") (literal "/dev/tty") (regex #"^/dev/fd/"))
(deny file-read* (subpath (param "HOME")))
(allow file-read* (subpath (param "WORKTREE")) (subpath (param "GIT_DIR")))
```

- Writes are allowed only in the worktree, `TEMP`, and the check's own output and terminal (`/dev/null`, `/dev/stdout`, `/dev/stderr`, `/dev/tty`, `/dev/fd/*`). Unlike Linux, where `/tmp` is the sandbox's own, `/tmp` itself is not writable: a check that writes a fixed `/tmp` path fails on macOS; use `TMPDIR`.
- `TEMP` is a folder Foedrum makes for the check under the system temp folder (`os.tmpdir()`) and removes after it; the check gets it as `TMPDIR` and as `HOME`, so tools that write under `~` find an empty home they may write. `GIT_DIR` is the worktree's repository, as on Linux, or the worktree again when it has none. All are real paths: Seatbelt matches real paths, and macOS's temp folder is under the link `/var`.
- `com.apple.SecurityServer` is the Keychain's service, where gh keeps its login on macOS (ADR 0073): denied, so `security find-generic-password` gets nothing.
- The profile allows by default, so the brokers that start a process for the caller are denied by name: launchd's job creation (`launchctl submit`), LaunchServices (`open`, `lsopen`, `launchservicesd`) and Apple Events. A process one of them started would run outside the sandbox, with the network and the Keychain (review of #357). These operation names come from Apple's profile language as `sandbox-runtime` and Apple's own profiles use it; no test runs them against macOS, and a broker they miss stays open. A profile that denies by default would close the class, at the cost of listing every read a toolchain needs; left for when a check needs it.

### Why no network
A check reads a tree; it fetches nothing. Dependencies are installed before it by the repository's `setup` command (ADR 0023), which nothing runs yet (#349), not by the check itself. ADR 0069's advice to write `npm ci && npm test` meanwhile no longer works: a check that needs installed dependencies fails until #349. With no network, a login a check reads cannot leave the machine through it; and an allowlist (what Claude Code's sandbox has for brewers) would need a proxy that a check, needing no host, has no use for.

### What a check can still read
- Everything outside the home folder: `/etc`, the system's tools, other users' world-readable files, and on Linux any other path not hidden above.
- On WSL2, the Windows drives under `/mnt`, with the Windows user's logins in files there (as for brewers, ADR 0087; #247).
- Logins kept outside the home folder (a `GH_CONFIG_DIR` or `XDG_CONFIG_HOME` pointing elsewhere), and on macOS any other Mach service than the Keychain's.
- Its worktree and its repository's history, which it may read by design.

## Consequences
- On Linux, WSL2 and macOS a check can no longer reach gh's login, the home folder's credentials or the network; on Linux it needs bubblewrap, which doctor already names. The line `foedrum serve` printed at the sandboxed level goes.
- A check that needs the network (a test against a live service, an install) fails in the sandbox until its repository moves that to `setup` (#349); one that needs a toolchain installed in the home folder (`~/.nvm`, `~/.cargo`, `~/.rustup`, `~/.sdkman`) does not find it. Install toolchains outside the home folder for check steps.
- On Ubuntu 24.04 and later, AppArmor keeps bwrap from making its user namespaces unless a profile lets it (`kernel.apparmor_restrict_unprivileged_userns` is 1): CI's ubuntu leg showed it on #357. There check steps are unstarted with bwrap's message, never run without the sandbox, and `foedrum doctor` names the AppArmor profile that Claude Code's sandbox docs give ([Sandboxing](https://code.claude.com/docs/en/sandboxing), "Ubuntu 24.04 and later: allow bubblewrap to create user namespaces"). Claude Code's own sandbox for brewers needs the same profile.
- `sandbox-exec` is deprecated. When macOS removes it, checks there are unstarted with the reason, never run unsandboxed.
- A reading may carry `unsandboxed`; existing logs and state branches still fold.
- `foedrum doctor` says under the isolation level where check steps run: in the sandbox on the sandboxed level, only in bubblewrap's sandbox (or not at all) on permissions-only Linux, and outside any sandbox on native Windows.
- The integration test (`test/integration/check-sandbox.test.ts`) runs where the sandbox runs: on macOS, and on Linux where `bwrap` is installed and can make its namespaces; elsewhere it skips with that reason.

## Alternatives considered
- **`@anthropic-ai/sandbox-runtime`.** What Claude Code's sandbox is built on, with the same two backends; it adds an allowlist proxy, which a check with no network does not need, and four runtime dependencies of a package marked beta, against `DEPENDENCIES.md`'s single runtime dependency.
- **Run checks through `claude` in its sandbox.** A model session, and its tokens, to run one command line; ADR 0069 keeps checks token-free.
- **Fall back to running unsandboxed when the sandbox cannot start.** It would silently reopen #190 on any machine without bubblewrap; a check that cannot be sandboxed is a fact a human fixes once.
- **A container per check.** The container level (ADR 0010) is optional and needs a runtime; the OS sandbox is on every macOS and one package away on Linux.
- **Hide the WSL2 `/mnt` drives too.** A Brewery whose work root is on a Windows drive would then hide its own worktree; left with #247, where brewers have the same question.
