# 0158. A repository's setup runs in the check sandbox, with the network kept

Date: 2026-10-23 · Status: Accepted · Amends [0140](0140-a-repository-s-setup-runs-before-a-check-step-s-checks-with-the-network.md) (setup no longer runs outside every sandbox: it runs in the check sandbox with the network, its reading says `unsandboxed` on native Windows only, and `serveSetup`'s refusal of a sandboxed minimum with a setup goes) and [0076](0076-check-steps-run-in-an-os-sandbox-with-no-network.md) (the check sandbox has a variant that keeps the network, for setup only)

## Context
Since [ADR 0140](0140-a-repository-s-setup-runs-before-a-check-step-s-checks-with-the-network.md) a repository's `setup` (`npm ci`, `dotnet restore`) runs in a check step's worktree before its checks, through plain `execProcess`: with the network, the Cellar user's home folder, `/run` and the Keychain. ADR 0140 recorded the path that makes that a risk. In a later step's worktree, setup runs build files a brewer may have committed (an MSBuild `Directory.Build.targets` that `dotnet restore` evaluates, a `setup.py` that `pip install` runs, a `Gemfile`, a worktree `.npmrc`). A brewer steered by an injected issue can write any of them (ADR 0076, Context), and they then run where gh's login is reachable ([ADR 0073](0073-github-only-through-gh-s-own-login.md)). That is #190's path again.

No layer covers it. The brewers' sandbox does not run setup, ADR 0140 routes setup around the checks' no-network sandbox, and `npm_config_ignore_scripts` only covers npm's lifecycle scripts. The owner is the check sandbox, the row "A check step running code a brewer wrote" in [`docs/trust-boundaries.md`](../trust-boundaries.md). This improves that owner and adds no layer (#382).

## Decision

### One sandbox, with or without the network
- `sandboxedChecks` (`src/platform/check-sandbox.ts`) takes `network: true` for a runner whose sandbox keeps the network. Only that changes:
  - **Linux and WSL2:** bwrap's arguments are ADR 0076's without `--unshare-net`, so the sandbox shares the host's network namespace.
  - **macOS:** the Seatbelt profile is ADR 0076's with `(deny network*)` replaced by `(deny network-outbound (remote unix-socket))` and `(allow network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))`. Seatbelt's `network*` covers Unix-domain sockets as well as IP, so dropping it whole would let a setup connect to every Unix socket outside the home folder, such as the ssh-agent launchd starts under `/private/tmp/com.apple.launchd.*/Listeners`, whose key can push to GitHub as the user (review of #422). A setup keeps IP, and of the Unix sockets only mDNSResponder's, through which the system resolver looks names up.
- Everything else is the check's sandbox as ADR 0076 (and [ADR 0142](0142-a-macos-check-may-stat-the-folders-above-its-worktree-in-the-home-folder.md)) builds it. The home folder and `/run` are hidden, the Keychain's service and the process brokers (launchd's job creation, LaunchServices, Apple Events) are denied, writes go only to the worktree and the temporary folder, the worktree's repository is read-only, the pid namespace and the new session stay, and every path is a real path.
- **The resolver's file.** On Linux `/etc/resolv.conf` is often a link into `/run` (systemd-resolved's `/run/systemd/resolve/stub-resolv.conf` on Ubuntu). The sandbox hides `/run`, so an install could not look up its registry. With the network kept, when the real path of `/etc/resolv.conf` is under `/run/`, that one file is bound back read-only, after `/run` is hidden. It is a list of name servers, not a socket. Nothing else under `/run` comes back: the user's D-Bus socket and WSL2's interop socket stay hidden. A check has no network, so it gets no resolver's file. When `/etc/resolv.conf` is elsewhere (WSL2 writes its own file) or cannot be resolved, nothing is bound.
- **Never unsandboxed outside Windows.** A setup whose sandbox cannot start (no `bwrap`, no `/usr/bin/sandbox-exec`, a path that cannot be resolved, bwrap or sandbox-exec failing under its own name) reads `unstarted` with the reason, as a check does. ADR 0140's table turns that into `blocked`, `environment`: `the setup "npm ci" could not start: …`. There is no fallback to `execProcess`.

### Where setup runs
| Platform | A repository's setup starts as |
|---|---|
| Linux, WSL2 | `bwrap <ADR 0076's arguments, without --unshare-net> /bin/sh -c <line>` |
| macOS | `/usr/bin/sandbox-exec -D … -p <ADR 0076's profile, IP and mDNSResponder's socket allowed, other Unix sockets denied> /bin/sh -c <line>` |
| Native Windows | as before: cmd.exe through `shellCommand` in a Job Object, no sandbox (ADR 0140) |

- `serve`'s shell gives `ServeShell.setup` as `sandboxedChecks({ exec: execProcess, …, network: true })` beside the checks' `exec`. The check runner does not change how it calls it.
- **The reading says `unsandboxed` only where no sandbox held it**: on native Windows, as a check's reading does (ADR 0076). Before, every setup reading said `"unsandboxed": true` on every platform. Existing logs and state branches still fold.

### Package caches
The home folder stays hidden, its caches too (`~/.npm`, `~/.nuget/packages`, `~/.cache/pip`, `~/.bundle`). A cache there can hold credentials (a registry token in `~/.npmrc`, NuGet's `NuGet.Config`), and a setup could also poison it for the user's own builds. A setup needs no cache folder of its own. The writable empty home the sandbox already gives a check is its cache:
- **Linux and WSL2:** the `--tmpfs <home>` over the home folder, at its real path, so `HOME` stays as it is. An install writes `~/.npm/_cacache` (or NuGet's, pip's) there, in memory, and it goes with the sandbox.
- **macOS:** the temporary folder Foedrum makes per run under `os.tmpdir()`, given as `HOME` and `TMPDIR` (ADR 0076), removed after the run.

So each setup downloads what it installs, every time: ADR 0140's consequence that "npm's own cache under the home folder is used" no longer holds. A repository that needs a warm cache names one in its worktree in its own setup line (`npm ci --cache .npm-cache`). That cache is then a file of the worktree, which the next checks and the next steps can see and change.

### serve no longer refuses a setup under a sandboxed minimum
ADR 0140 had `serveSetup` refuse to start when the Brewery requires the sandboxed level, a recipe has a check step and a repository has `setup`, because setup ran outside the sandbox on every level. Now setup runs in the sandbox wherever a check does. On native Windows the checks' own refusal (ADR 0076) already stops `serve` for the same Brewery: setup only runs before check steps. So the setup line goes, and no case loses its refusal.

### What a setup can still reach
- Everything ADR 0076 says a check can still read: the system outside the home folder, the Windows drives under `/mnt` on WSL2, logins kept outside the home folder, and on macOS any Mach service but the Keychain's.
- **The network**, with no allowlist. A setup can send what it reads (the worktree, the repository's history, the system's files) anywhere, and fetch and run what it likes inside the sandbox. A registry-only allowlist would need a proxy or per-ecosystem host lists (ADR 0140, Alternatives); it waits for proof, under CLAUDE.md's safeguard rule, of something this sandbox lets out.
- Local services on the host's loopback (a database, a development server), since the network namespace is the host's. On macOS the profile allows it too.
- **On Linux and WSL2, the host's abstract Unix sockets** (review of #422). An abstract socket (a name starting with `@`) belongs to the network namespace, not the file system, so hiding `/run` and `/tmp` does not hide it, and `/proc/net/unix` lists them. A setup can connect to an X server's `@/tmp/.X11-unix/X0` and type into the user's terminal, outside the sandbox, or to a D-Bus session bus started with a `unix:abstract=` address (dbus-launch without systemd's user session), where the Secret Service hands out gh's login. On a Linux Cellar with such a bus or an X session, a setup can reach gh's login; one whose session bus is systemd's `/run/user/<uid>/bus`, and that runs no X server, keeps it out of reach. Closing it needs a network namespace of the setup's own with a user-mode network stack (pasta or slirp4netns), or a seccomp filter that refuses `socket(AF_UNIX)`; that is #425. A check keeps `--unshare-net` and reaches none.
- On macOS, gh's login stays out of reach: the home folder, the Keychain's service and every Unix socket but mDNSResponder's are denied.

## Consequences
- On macOS a brewer-written build file run by setup can no longer read gh's login, the home folder's credentials, the Keychain or the user's ssh-agent. On Linux and WSL2 it can no longer read the home folder's credentials or the path D-Bus socket under `/run`, but it still reaches the host's abstract Unix sockets (above). It still has the network.
- On Linux a repository with `setup` needs bubblewrap, as its check steps already do. Where AppArmor keeps bwrap from making its namespaces (Ubuntu 24.04 and later), its setup does not start either, and doctor already names the profile.
- An install that reads its configuration or credentials from the home folder (a private registry's token in `~/.npmrc`, a NuGet source's credentials, `~/.netrc`) does not find them. Install from a public registry, or give the configuration in the worktree through the repository's own files. A token in a worktree file is readable by brewers and checks.
- A toolchain under the home folder (`~/.nvm`, `~/.dotnet`, `~/.cargo`) is not found by setup either, as for checks (ADR 0076): install toolchains outside the home folder.
- Each setup downloads its packages again: slower check steps, more traffic to the registry. Linux keeps that cache in memory for the run.
- Tools on macOS that need Mach services ADR 0076 denies (the Keychain's `SecurityServer` for a certificate or login) fail in setup. node's bundled CA store and the system trust service (`trustd`) are not denied.
- The integration test (`test/integration/check-sandbox.test.ts`) gains a setup's suite: it reaches a server on 127.0.0.1, and still cannot read a file in the home folder or write outside its worktree; on macOS it cannot connect to a Unix socket outside its worktree, and on Linux it reads `/etc/resolv.conf` and sees only the resolver's folder under `/run`. It runs where the check sandbox runs (macOS, Linux with a working bwrap) and skips elsewhere.
- `docs/trust-boundaries.md`'s row "A check step running code a brewer wrote" names the check sandbox, with no network for checks and with the network for a repository's setup.

## Alternatives considered
- **Keep setup outside the sandbox (ADR 0140).** It leaves the path ADR 0140 recorded open.
- **A registry-only allowlist through a proxy.** It would also stop a setup from sending what it reads elsewhere. It needs a proxy and host lists per ecosystem, and what it guards against reaches no login: left until a case needs it.
- **Bind the user's package caches into the sandbox.** Faster installs, but a cache in the home folder sits beside the user's registry credentials and is shared with the user's own builds. A writable bind would let a setup poison it, and a read-only one does not work for an install that writes.
- **A cache folder per repository in the work root, bound writable.** A warm cache without the home folder, but it would be shared between the batches of a repository, so one batch's setup could poison the next's. A repository that wants that names a cache in its own setup line.
- **Bind all of `/run/systemd/resolve` for the resolver.** The folder also holds systemd-resolved's varlink socket. The one file is all the resolver library reads; glibc falls back from the `resolve` NSS module to DNS when the socket is not there.
