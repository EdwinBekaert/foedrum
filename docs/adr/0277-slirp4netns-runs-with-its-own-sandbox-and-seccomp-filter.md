# 0277. slirp4netns runs with its own sandbox and seccomp filter

Date: 2026-10-31 · Status: Accepted · Amends [0218](0218-a-linux-setup-gets-a-network-namespace-of-its-own-through-a-user-mode-network-stack.md) (slirp4netns's arguments gain `--enable-sandbox` and `--enable-seccomp`)

## Context
Since [ADR 0218](0218-a-linux-setup-gets-a-network-namespace-of-its-own-through-a-user-mode-network-stack.md) a repository's setup on Linux and WSL2 gets the network from a user-mode network stack, slirp4netns first, attached to bwrap's network namespace from outside.
slirp4netns runs as the Cellar's user, outside bwrap's sandbox, and its libslirp parses every packet the setup sends.
A setup runs a build file a brewer may have written, so those packets are the brewer's.
libslirp has had memory-safety flaws, and a flaw reached through a crafted packet would run code as the Cellar's user with the user's files and gh's login in reach.
ADR 0218 started slirp4netns without its own sandbox and seccomp filter; the security review of #564 found it (#425, #577).

The owner is the check sandbox, the row "A check step running code a brewer wrote" in [`docs/trust-boundaries.md`](../trust-boundaries.md).
This improves that owner and adds no layer: the flags are the stack's own.

The tools' own documentation, read for this ADR on 2026-10-31:

- **slirp4netns(1)** ([Ubuntu noble, 1.2.1-1build2](https://manpages.ubuntu.com/manpages/noble/man1/slirp4netns.1.html)): `--enable-sandbox` (since v0.4.0) will "enter the user namespace and create a new mount namespace where only /etc and /run are mounted from the host", and "Requires /etc/resolv.conf not to be a symlink to a file outside /etc and /run". `--enable-seccomp` (since v0.4.0, experimental) will "enable seccomp(2) to limit syscalls. Typically used in conjunction with --enable-sandbox." It needs a slirp4netns built with libseccomp; Ubuntu's prints `libseccomp: 2.5.5` in its `--version`.
- **Rootless Podman** ([containers/common, `libnetwork/slirp4netns/slirp4netns.go`](https://github.com/containers/common/blob/main/libnetwork/slirp4netns/slirp4netns.go)) reads `slirp4netns --help` and adds `--enable-sandbox` when it is listed (unless pivot_root is turned off in its configuration) and `--enable-seccomp` when it is listed.
- **passt** ([passt.top, Security](https://passt.top/passt/about/)): pasta detaches the user, mount, IPC, UTS and PID namespaces with its default options, drops all capabilities, and runs under a seccomp profile of its own (43 syscalls for pasta on x86_64). Ubuntu also confines it under the `passt` AppArmor profile (ADR 0218).

## Decision

### slirp4netns starts with both flags, always
slirp4netns's arguments are ADR 0218's with `--enable-sandbox --enable-seccomp`:

| Stack | Arguments |
|---|---|
| slirp4netns | `--configure --mtu=65520 --disable-host-loopback --enable-sandbox --enable-seccomp --ready-fd=3 --exit-fd=4 <pid> tap0` |

- Both, not the sandbox alone: the sandbox narrows what a taken-over slirp4netns sees on the file system (`/etc` and `/run`), and the filter narrows the syscalls it can make. Podman uses both for the same tool.
- Unlike Podman, Foedrum does not read `--help` and drop a flag slirp4netns does not list. A setup's packets are a brewer's, so slirp4netns runs with both or the setup does not run.

### A slirp4netns that refuses a flag
A slirp4netns older than 0.4.0 refuses the flag it does not know; one built without libseccomp refuses `--enable-seccomp`; and `--enable-sandbox` fails where `/etc/resolv.conf` links outside `/etc` and `/run`.
Each exits before it writes on its ready descriptor, which is ADR 0218's stack that fails to start: Foedrum stops bwrap, whose child still waits on its block descriptor, so the line never runs, and the setup reads `unstarted` with slirp4netns's message.
No new path is needed, and none is added.
Foedrum does not fall back to pasta then: slirp4netns is the stack found first, and a refusal says what to fix.

### Doctor
Doctor says nothing new.
It cannot tell beforehand from the version alone: a version since 0.4.0 knows both flags, but whether the build has libseccomp, and whether `/etc/resolv.conf` stays inside `/etc` and `/run`, the version does not say.
The setup's `unstarted` reading names the cause where it happens.

### pasta unchanged
pasta sandboxes itself by default, in namespaces of its own with a seccomp profile and no capabilities (Context), so its arguments do not change.

## Consequences
- A flaw in libslirp reached through a setup's packets runs in slirp4netns's own user and mount namespaces, with only `/etc` and `/run` of the host, under a seccomp filter: the user's home, with gh's login, is out of its reach.
- A Linux machine whose slirp4netns predates 0.4.0, was built without libseccomp, or whose `/etc/resolv.conf` links outside `/etc` and `/run`, no longer runs a repository's setup: it reads `unstarted` with slirp4netns's message. Ubuntu 24.04 (1.2.1, with libseccomp, the link into `/run`) and current Fedora run it.
- The unit tests hold the arguments and a fake slirp4netns that refuses `--enable-seccomp`. CI's ubuntu leg runs the integration suite's setup cases against the real slirp4netns with both flags: a setup reaches a server on a non-loopback address of the runner, resolves a name, and is refused the host's loopback and abstract sockets.

## Alternatives considered
- **`--enable-sandbox` only.** It keeps the file system narrow but leaves every syscall to a taken-over slirp4netns, among them those of a kernel exploit. The filter costs nothing where the build has libseccomp, as Ubuntu's and Fedora's do.
- **Read `--help` and pass what slirp4netns lists, as Podman does.** An older or smaller build would then parse a brewer's packets unsandboxed, without a word. Rejected: the setup does not run instead, and says why.
- **Fall back to pasta when slirp4netns refuses a flag.** It hides a broken slirp4netns behind pasta's resolver gap (ADR 0218's Consequences) on a desktop with systemd-resolved, where the setup would then fail to resolve names instead of saying why.
- **A doctor problem from the version.** The version alone does not decide it (Decision).
