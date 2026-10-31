# 0277. slirp4netns runs under its seccomp filter

Date: 2026-10-31 · Status: Accepted · Amends [0218](0218-a-linux-setup-gets-a-network-namespace-of-its-own-through-a-user-mode-network-stack.md) (slirp4netns's arguments gain `--enable-seccomp`)

## Context
Since [ADR 0218](0218-a-linux-setup-gets-a-network-namespace-of-its-own-through-a-user-mode-network-stack.md) a repository's setup on Linux and WSL2 gets the network from a user-mode network stack, slirp4netns first, attached to bwrap's network namespace from outside.
slirp4netns runs as the Cellar's user, outside bwrap's sandbox, and its libslirp parses every packet the setup sends.
A setup runs a build file a brewer may have written, so those packets are the brewer's.
libslirp has had memory-safety flaws, and a flaw reached through a crafted packet would run code as the Cellar's user with the user's files and gh's login in reach.
ADR 0218 started slirp4netns without its own sandbox and seccomp filter; the security review of #564 found it (#425, #577).

The owner is the check sandbox, the row "A check step running code a brewer wrote" in [`docs/trust-boundaries.md`](../trust-boundaries.md).
This improves that owner and adds no layer: the flag is the stack's own.

The tools' own documentation and code, read for this ADR on 2026-10-31:

- **slirp4netns(1)** ([Ubuntu noble, 1.2.1-1build2](https://manpages.ubuntu.com/manpages/noble/man1/slirp4netns.1.html)): `--enable-sandbox` (since v0.4.0) will "enter the user namespace and create a new mount namespace where only /etc and /run are mounted from the host". `--enable-seccomp` (since v0.4.0, experimental) will "enable seccomp(2) to limit syscalls. Typically used in conjunction with --enable-sandbox." It needs a slirp4netns built with libseccomp; Ubuntu's prints `libseccomp: 2.5.5` in its `--version`.
- **slirp4netns's `main.c`** ([rootless-containers/slirp4netns](https://github.com/rootless-containers/slirp4netns/blob/master/main.c), `parent()`): when `enable_sandbox` is set and slirp4netns is not root, it joins the target's user namespace and calls `setegid(0)` and `seteuid(0)`; when either fails it prints its name and `parent failed`, and exits.
- **Rootless Podman** ([containers/common, `libnetwork/slirp4netns/slirp4netns.go`](https://github.com/containers/common/blob/main/libnetwork/slirp4netns/slirp4netns.go)) reads `slirp4netns --help` and adds `--enable-sandbox` when it is listed (unless pivot_root is turned off in its configuration) and `--enable-seccomp` when it is listed. Its rootless user namespace maps the user to root, so uid 0 exists there.
- **passt** ([passt.top, Security](https://passt.top/passt/about/)): pasta detaches the user, mount, IPC, UTS and PID namespaces with its default options, drops all capabilities, and runs under a seccomp profile of its own (43 syscalls for pasta on x86_64). Ubuntu also confines it under the `passt` AppArmor profile (ADR 0218).

What CI's ubuntu leg (Ubuntu 24.04, slirp4netns 1.2.1, bubblewrap 0.9.0) showed on 2026-10-31, in [run 41214208857](https://github.com/EdwinBekaert/foedrum/actions/runs/41214208857) of #702, with both flags: every setup read `unstarted` with `WARNING: Support for seccomp is experimental`, `received tapfd=7`, `setegid(0)`, `parent failed`.
bwrap's user namespace maps the Cellar's uid to itself and no other, so uid and gid 0 do not exist there, and slirp4netns's sandbox cannot become root in it.
The seccomp filter loaded without an error.

## Decision

### slirp4netns starts under its seccomp filter, always
slirp4netns's arguments are ADR 0218's with `--enable-seccomp`:

| Stack | Arguments |
|---|---|
| slirp4netns | `--configure --mtu=65520 --disable-host-loopback --enable-seccomp --ready-fd=3 --exit-fd=4 <pid> tap0` |

- The filter narrows the syscalls a taken-over slirp4netns can make.
- Unlike Podman, Foedrum does not read `--help` and drop the flag when slirp4netns does not list it. A setup's packets are a brewer's, so slirp4netns runs under the filter or the setup does not run.

### Not `--enable-sandbox`
slirp4netns's own sandbox needs uid 0 mapped in the setup's user namespace (Context), and bwrap maps the Cellar's uid to itself.
Mapping the user to root there (bwrap's `--uid 0 --gid 0`) would change what every setup runs as, root inside its namespace, where npm, pip and bundler behave differently or warn. That is a change to ADR 0218 and [ADR 0158](0158-a-repository-s-setup-runs-in-the-check-sandbox-with-the-network-kept.md) of its own, out of this record's reach.

### A slirp4netns that refuses the flag
A slirp4netns older than 0.4.0 refuses the flag it does not know, and one built without libseccomp refuses `--enable-seccomp`.
Each exits before it writes on its ready descriptor, which is ADR 0218's stack that fails to start: Foedrum stops bwrap, whose child still waits on its block descriptor, so the line never runs, and the setup reads `unstarted` with slirp4netns's message, as CI's run with `--enable-sandbox` showed (Context).
No new path is needed, and none is added.
Foedrum does not fall back to pasta then: slirp4netns is the stack found first, and a refusal says what to fix.

### Doctor
Doctor says nothing new.
It cannot tell beforehand from the version alone: a version since 0.4.0 knows the flag, but whether the build has libseccomp the version does not say.
The setup's `unstarted` reading names the cause where it happens.

### pasta unchanged
pasta sandboxes itself by default, in namespaces of its own with a seccomp profile and no capabilities (Context), so its arguments do not change.

## Consequences
- A flaw in libslirp reached through a setup's packets runs under slirp4netns's seccomp filter, which refuses the syscalls it lists.
- **What it still reaches:** everything the Cellar's user reaches, but through the syscalls the filter lets through. That includes the user's home folder with gh's `hosts.yml`, the host's `/run` with the user's D-Bus session bus, through which the Secret Service hands out a login it keeps (gh's where gh stores it in the keyring), and the host's network; the filter lets `open`, `socket` and `connect` through. Closing it is a follow-up of its own ([#705](https://github.com/EdwinBekaert/foedrum/issues/705)); this record narrows the gap and does not claim it closed.
- A Linux machine whose slirp4netns predates 0.4.0 or was built without libseccomp no longer runs a repository's setup: it reads `unstarted` with slirp4netns's message. Ubuntu 24.04 (1.2.1, with libseccomp) and current Fedora run it.
- The unit tests hold the arguments, that `--enable-sandbox` is not among them, and a fake slirp4netns that refuses `--enable-seccomp`. CI's ubuntu leg runs the integration suite's setup cases against the real slirp4netns with the filter: a setup reaches a server on a non-loopback address of the runner, resolves a name, and is refused the host's loopback and abstract sockets.

## Alternatives considered
- **`--enable-sandbox` too, as Podman does.** It needs uid 0 in the setup's user namespace and fails under bwrap (Context): no setup would run.
- **Map the user to root in the setup's namespace, so the sandbox can start.** It changes what every setup runs as (Decision). Out of scope.
- **Read `--help` and pass what slirp4netns lists, as Podman does.** An older or smaller build would then parse a brewer's packets without a filter, without a word. Rejected: the setup does not run instead, and says why.
- **Fall back to pasta when slirp4netns refuses the flag.** It hides a broken slirp4netns behind pasta's resolver gap (ADR 0218's Consequences) on a desktop with systemd-resolved, where the setup would then fail to resolve names instead of saying why.
- **A doctor problem from the version.** The version alone does not decide it (Decision).
