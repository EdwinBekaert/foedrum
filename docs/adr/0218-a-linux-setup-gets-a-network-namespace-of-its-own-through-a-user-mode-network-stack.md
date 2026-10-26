# 0218. A Linux setup gets a network namespace of its own, through a user-mode network stack

Date: 2026-10-26 · Status: Accepted · Amends [0158](0158-a-repository-s-setup-runs-in-the-check-sandbox-with-the-network-kept.md) (on Linux and WSL2 a setup keeps `--unshare-net`, its namespace gets the network through slirp4netns or pasta, the resolver's file is Foedrum's own, `serveSetup`'s refusal goes on Linux and WSL2, and "What a setup can still reach" loses the host's abstract Unix sockets and loopback), [0076](0076-check-steps-run-in-an-os-sandbox-with-no-network.md) (the setup variant of bwrap's arguments) and [0163](0163-a-repository-s-setup-runs-before-a-brewer-attempt.md) (serve's refusal of a sandboxed minimum with a setup goes on Linux and WSL2; native Windows keeps its line)

## Context
Since [ADR 0158](0158-a-repository-s-setup-runs-in-the-check-sandbox-with-the-network-kept.md) a repository's `setup` runs in the check sandbox with the network kept. On Linux and WSL2 that is bwrap without `--unshare-net`, so a setup shares the host's network namespace. An abstract Unix socket (a name starting with `@`) belongs to the network namespace, not the file system. Hiding `/run` and `/tmp` does not hide it, and `/proc/net/unix` lists every one. A build file a brewer committed, run by setup, can connect to an X server's `@/tmp/.X11-unix/X0` and type into the user's terminal, or to a D-Bus session bus with a `unix:abstract=` address, where the Secret Service hands out gh's login ([ADR 0073](0073-github-only-through-gh-s-own-login.md)). ADR 0158 recorded the gap, and `serveSetup` refuses a sandboxed minimum with a setup on Linux until it closes (#425).

The owner is the check sandbox, the row "A check step running code a brewer wrote" in [`docs/trust-boundaries.md`](../trust-boundaries.md). This improves that owner and adds no layer. The maintainer chose a user-mode network stack over a seccomp filter on 2026-10-25 (#425's comment).

The tools' own documentation, read for this ADR on 2026-10-26:

- **pasta(1)** ([Ubuntu noble, passt 0.0~git20240220.1e6f92b-1](https://manpages.ubuntu.com/manpages/noble/man1/pasta.1.html)): `pasta [OPTION]... PID`. Given a PID, pasta "associates to an existing user and network namespace", the user namespace being "the one of the corresponding process". `--config-net` will "set up addresses and routes as configured or sourced from the host" and bring up the tap interface. The default "is to fork into background", and `-P` writes the PID "once initialisation is done, before forking to background". pasta terminates when the target namespace's procfs entry is gone (`--no-netns-quit` turns that off). `-t`, `-u` (host to namespace) and `-T`, `-U` ("from target namespace to init namespace") all default to `auto` in pasta, which forwards the ports bound on the other side. `--no-map-gw`: "Don't remap TCP connections and untracked UDP traffic, with the gateway address as destination, to the host"; without it the gateway address reaches the host's loopback. `--dns-forward addr`: "Map addr … as seen from guest or namespace to the first configured DNS resolver". `-a`, `-n` and `-g` set the namespace's address, netmask and gateway; by default they are copied from the host's interface. `-4` ignores IPv6.
- **slirp4netns(1)** ([Ubuntu noble, 1.2.1-1build2](https://manpages.ubuntu.com/manpages/noble/man1/slirp4netns.1.html)): `slirp4netns [OPTION]... PID|PATH [TAPNAME]`. `--configure` brings up the tap interface, "IP will be set to 10.0.2.100". The gateway 10.0.2.2 is the host, and `--disable-host-loopback` will "prohibit connecting to 127.0.0.1:* on the host namespace". The built-in DNS is 10.0.2.3. `--ready-fd` names "the FD to write to when the initialization steps are finished", and `--exit-fd` "the FD for terminating slirp4netns". The page's example attaches to the PID of a process made by `unshare --user --map-root-user --net`.
- **bwrap(1)** ([Debian bookworm](https://manpages.debian.org/bookworm/bubblewrap/bwrap.1.en.html)): `--info-fd FD` writes "information in JSON format about the sandbox to FD", among it `child-pid`. `--block-fd FD` blocks the sandbox "on reading from FD until some data is available". `--ro-bind-data FD DEST` will "Copy from FD to file which is bind-mounted readonly on DEST".

What CI's ubuntu leg (Ubuntu 24.04, bubblewrap 0.9.0, slirp4netns 1.2.1, `pasta unknown version`) showed on 2026-10-26, in the runs of #425:
- Attached to the child of bwrap with `--dev /dev`, both stacks entered its user namespace and were refused its network namespace: `pasta: Couldn't switch to pasta namespaces: Operation not permitted` and `slirp4netns: setns(CLONE_NEWNET): Operation not permitted`. So did `nsenter --user --net`, with no AppArmor denial.
- `lsns` showed why: bwrap's child was in a user namespace whose parent was another user namespace of bwrap's, and the network namespace was owned by that outer one, which no process was in any more. A process that joins the child's user namespace has no capability over a network namespace its parent owns.
- bubblewrap.c (v0.9.0) says why it nests: unprivileged, and without `--userns-block-fd`, when `--dev` needs devpts it maps the user to root in the first user namespace, "otherwise we can't mount the devpts filesystem because root is not mapped. Later we will create another child user namespace and map back to the real uid". The network namespace is cloned with the first.
- With the setup's `/dev` built without devpts (below), bwrap made one user namespace, which owned the network namespace. `nsenter --user --net` entered it. slirp4netns configured `tap0` at 10.0.2.100/24, and pasta `eth0` at 10.0.2.100/24, both with the default route via 10.0.2.2. pasta ran under the `passt (enforce)` AppArmor profile, which Ubuntu applies to it, and was not refused.
- pasta also printed `Couldn't get any nameserver address`: the runner's `/etc/resolv.conf` names only systemd-resolved's stub, 127.0.0.53, and pasta found no resolver to forward 10.0.2.3 to.

We test our arguments and the wiring with a fake process runner, and in `test/integration/` that a real setup keeps the host's abstract sockets and loopback out and still has a network. Whether pasta, slirp4netns or bwrap work is theirs.

## Decision

### The setup's namespace is its own
On Linux and WSL2 a setup's bwrap keeps `--unshare-net`, as a check's does. Its new network namespace gets the network from a user-mode network stack, slirp4netns or pasta, attached to it from outside. The namespace is new, so the host's abstract Unix sockets are not in it, and nothing in it is the host's loopback. macOS (ADR 0158's profile) and native Windows (no sandbox) do not change.

### The wiring: bwrap tells the pid, the stack attaches, bwrap waits for it
| Step | What happens |
|---|---|
| 1 | bwrap starts with `--unshare-net --info-fd 3 --block-fd 4`, and `--ro-bind-data 5 <resolver>` (below). It makes its namespaces, writes `{"child-pid": <pid>}` to fd 3, and its child waits on fd 4 before the line runs |
| 2 | Foedrum reads the pid and starts the stack against it: `slirp4netns … <pid> tap0` or `pasta … <pid>` |
| 3 | When the stack is up (below), Foedrum writes one byte to fd 4, and the line runs |
| 4 | When bwrap ends, the stack ends with it (below) |

- **The process runner gains `pipes`** (`ExecOptions.pipes`, `src/platform/processes.ts`): a count of extra pipes the program gets as file descriptors 3, 4, … in order, handed to the caller's `onPipes` as streams once it has started. It names no tool and no direction, so any program that talks over a numbered descriptor can use it. It is refused with `shell`, with a `.cmd` or `.bat` file, which runs through cmd.exe on Windows (ADR 0031), and with a Windows Job Object, whose helper passes no descriptor but the standard three. Everything else about the run is the runner's as before: the deadline, the stop, the output limit and the tree kill (ADR 0035).
- **When the stack is up.** pasta forks to the background once it has configured the namespace, so the pasta Foedrum started exits 0 then, and a non-zero exit is its failure, with its message. slirp4netns stays in the foreground and writes to its `--ready-fd 3` when it is up. It ends when its `--exit-fd 4` closes, which is when Foedrum stops it or dies.
- **How both end.** bwrap ends as ADR 0076 says: the runner's deadline, the stop and the output limit kill its tree, and `--die-with-parent` and the pid namespace take the line's processes with it. Then Foedrum stops slirp4netns through the runner, which kills its tree. slirp4netns gets the same deadline and stop as bwrap, and its exit pipe closes if Foedrum itself dies. pasta's background process is outside the runner's tree. It quits when the namespace's procfs entry is gone, which is when bwrap's child, the pid namespace's first process, has ended.
- **A stack that dies mid-run** leaves the namespace without a network: the setup's downloads fail and it reads as a failed setup, as when the registry is down. It never gains the host's namespace.
- **A stack that fails to start** (it exits before it is up, or exits non-zero) makes Foedrum stop bwrap, whose child is still waiting on fd 4, so the line never runs. The setup reads `unstarted` with the stack's message, as for bwrap failing under its own name (ADR 0076). It never reads as a failed setup, and never runs without the namespace. bwrap that ends before it writes a pid has failed under its own name, and reads `unstarted` with its own message as before, also when Foedrum stopped it for want of a pid before the runner saw it end. A pid Foedrum cannot read stops bwrap the same way. A stack counts as failed only while bwrap runs: one Foedrum stops after bwrap has ended (at its deadline, at a stop) has not failed, and the run reads as bwrap's, timed out or stopped.

### The setup's /dev, without devpts
With `--dev /dev`, bwrap nests a second user namespace and the network namespace belongs to the outer one, which no stack can join (Context). So a setup's bwrap builds its `/dev` from a list Foedrum keeps, in place of `--dev /dev`:

| Arguments | Why |
|---|---|
| `--tmpfs /dev` | An empty `/dev` of the sandbox's own |
| `--dev-bind /dev/<node> /dev/<node>` for `null`, `zero`, `full`, `random`, `urandom` and `tty` | The devices an install uses, the same nodes `--dev` gives |
| `--tmpfs /dev/shm` | Shared memory of the sandbox's own |
| `--symlink /proc/self/fd /dev/fd`, and `/proc/self/fd/0`, `1`, `2` as `/dev/stdin`, `/dev/stdout`, `/dev/stderr` | The links shells and tools open |

- **No pseudo-terminal:** a setup has no `/dev/pts` or `/dev/ptmx`, so it cannot open one. Its stdin is already empty (ADR 0140), so an install that needs a terminal does not work there either way. It now fails with a missing file.
- A check keeps `--dev /dev`: it has no network namespace for a stack to join.

### slirp4netns first, pasta second
- `sandboxedChecks` finds `slirp4netns` on the user's `PATH` by `resolveExecutable`, as bwrap, and `pasta` where slirp4netns is not there (decided with the maintainer on 2026-10-26, after the CI runs in Context).
- Both join a setup's namespace on Ubuntu (Context). slirp4netns is first because its resolver works on a desktop whose `/etc/resolv.conf` names only systemd-resolved's stub, as Ubuntu's and Fedora's do: it answers 10.0.2.3 itself. pasta found no resolver to forward to there (Consequences).
- **Neither there:** the setup reads `unstarted`: `neither slirp4netns nor pasta (passt) is on PATH: a repository's setup runs only in a network namespace of its own here; install slirp4netns (ADR 0218)`. Nothing starts.

### What the namespace reaches
The namespace's address is 10.0.2.100/24 with the gateway 10.0.2.2 under both stacks, IPv4 only, so the host's own addresses are never the namespace's:

| Stack | Arguments |
|---|---|
| pasta | `--config-net --quiet -4 -a 10.0.2.100 -n 24 -g 10.0.2.2 --no-map-gw -t none -u none -T none -U none --dns-forward 10.0.2.3 <pid>` |
| slirp4netns | `--configure --mtu=65520 --disable-host-loopback --ready-fd=3 --exit-fd=4 <pid> tap0` |

- `--no-map-gw` and `--disable-host-loopback` close the gateway's mapping to the host's loopback. pasta's `-T none -U none` close its default forwarding of the ports the host listens on into the namespace's own loopback, which would reach a host service on 127.0.0.1 as well. `-t none -u none` close the other way, so a server a setup starts is not offered on the host. slirp4netns forwards no port unless asked over its API socket, which Foedrum does not open.
- **What remains:** outbound TCP and UDP through the stack, as the host's user sends it, to any address but the host's loopback. Other addresses of the host, such as its LAN address or a bridge's, are reached like any machine on the network, by the services listening there. So are the host's DNS resolver, through the stack's address 10.0.2.3, and everything ADR 0158 lists besides the loopback and the abstract sockets.
- The stack itself runs as the Cellar's user outside the sandbox and parses the packets the setup sends. It is the user's own installed tool, as bwrap is.

### The resolver
In its own namespace a setup cannot use the host's `/etc/resolv.conf`: on Ubuntu it names systemd-resolved's stub, 127.0.0.53, which in the namespace is its own loopback and answers nothing. Foedrum writes `nameserver 10.0.2.3` through bwrap's `--ro-bind-data 5` at the real path of `/etc/resolv.conf` (after `/run` is hidden, so a link into `/run` finds its file), read-only. slirp4netns answers 10.0.2.3 itself, and pasta forwards it with `--dns-forward 10.0.2.3` to the host's first resolver it can use, when there is one (Consequences). ADR 0158's bind of the host's file back under `/run` goes. Its folder still shows under the hidden `/run` where the link points there, holding Foedrum's file only. A machine whose `/etc/resolv.conf` cannot be resolved gets the file at `/etc/resolv.conf` itself, where bwrap may fail under its own name and the setup reads `unstarted`.

### Doctor
On Linux `foedrum doctor` lists slirp4netns, or pasta where slirp4netns is not there, with its version, beside bwrap and socat; with neither, slirp4netns as missing. pasta prints its version as its first line's second word (`pasta 2024_09_06.6b38f07`), which is reported as it is, and none for Ubuntu's `pasta unknown version`. With neither, it reports a problem that is not required, written for someone on a Linux desktop or laptop: `slirp4netns or pasta (passt) not found`, `a repository's setup does not start without it; install slirp4netns (Debian and Ubuntu: sudo apt install slirp4netns; Fedora and Arch usually have slirp4netns or passt with Podman) (ADR 0218)`. A Brewery with no `setup` needs neither. Doctor gives no advice against pasta: it joins a setup's namespace under Ubuntu's AppArmor profile too (Context). The isolation level does not change: it describes what holds brewers (ADR 0010), and a setup either runs in its namespace or does not run.

### serve
`serveSetup`'s refusal of a sandboxed minimum with a setup goes on Linux and WSL2: the setup no longer reaches what the refusal guarded. Native Windows keeps its line (ADR 0163). A Cellar without a stack starts. Its setups read `unstarted`, and doctor says why.

### What a setup can still reach
ADR 0158's list without its third and fourth bullets on Linux and WSL2: everything a check can still read, the network with no allowlist, and on macOS the host's loopback (unchanged).

## Consequences
- A brewer-written build file run by setup on Linux and WSL2 no longer reaches the host's abstract Unix sockets (an X server, an abstract D-Bus bus) or the host's loopback services, so gh's login stays out of its reach there as on macOS.
- **A setup that used a service on the host's 127.0.0.1** (a database for its tests, a local registry mirror) no longer reaches it on Linux. Point it at an address of the host that is not the loopback, or start the service in the setup's line. macOS keeps the loopback.
- On Linux a repository with `setup` needs slirp4netns, or pasta, besides bubblewrap: without one, a repository's setup does not start.
- **pasta's resolver gap:** where pasta is the stack and the host's `/etc/resolv.conf` names only a loopback stub (systemd-resolved's 127.0.0.53), pasta has no resolver to forward 10.0.2.3 to, and a setup cannot look names up: its install fails to find its registry. Installing slirp4netns closes it. Giving pasta a resolver (`--dns` with the first nameserver of systemd-resolved's upstream list) waits for a case that needs pasta there.
- A setup has IPv4 only on Linux, and no pseudo-terminal.
- CI's ubuntu leg installs `slirp4netns` beside `bubblewrap`. pasta's arguments and wiring are tested through the fake process runner; that pasta joins a setup's namespace on Ubuntu was seen in CI's verification run (Context), not in the suite. The integration suite's setup cases fail there instead of skipping when the stack is missing, so the leg proves the isolation: the test listens on an abstract socket and the setup cannot connect, a server on the host's 127.0.0.1 is not reached, and a server on a non-loopback address of the runner is, through the stack, without leaving the machine.
- `docs/trust-boundaries.md`'s row says the setup's network namespace is its own on Linux.

## Alternatives considered
- **A seccomp filter that refuses `socket(AF_UNIX)`** (`bwrap --seccomp <fd>`), as Claude Code's sandbox does for brewers. Rejected with the maintainer on 2026-10-25: a hand-built BPF program per architecture (x86_64, aarch64) that must also refuse the foreign syscall ABIs (i386 compat, x32), and must let `socketpair` through for node's and libuv's child processes. It would leave the host's loopback services open.
- **pasta starts the namespace and bwrap runs inside it** (`pasta … -- bwrap …`). It needs no extra descriptor. But slirp4netns cannot run a command, so the second tool would need the descriptors anyway. bwrap would run as root in pasta's user namespace and have no `--unshare-net` of its own, and the namespace would be pasta's to make and keep.
- **pasta first.** The maintainer's first choice. It joins a setup's namespace as well, but on a desktop with systemd-resolved it gives the setup no resolver, so it would need Foedrum to find and pass one. Rejected with the maintainer on 2026-10-26.
- **AppArmor advice for pasta.** A first CI run suggested Ubuntu's `passt` profile kept pasta out. slirp4netns, which Ubuntu does not confine, was refused the same way, and the cause was bwrap's nested user namespace (Context). Dropped.
- **`--userns-block-fd`, attaching while the child is still in the outer user namespace.** bwrap then writes no uid or gid map: Foedrum would have to write them, and choose whether the sandbox runs as root in its namespace.
- **`--dev-bind /dev /dev`.** No devpts of the sandbox's own, but it hands the setup the host's `/dev`, with the user's terminals under `/dev/pts`.
- **Keep the host's namespace** (ADR 0158). The gap stays, and with it serve's refusal on Linux.
- **Run setup without a network.** An install cannot reach its registry, which is what setup is for (ADR 0140).
- **Bind the host's resolver file in the new namespace.** It names 127.0.0.53 on Ubuntu, which answers nothing there.
