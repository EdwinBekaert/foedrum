# 0400. pasta comes first for a setup where its resolver works, and slirp4netns's gap is recorded

Date: 2026-11-14 · Status: Accepted · Amends [0218](0218-a-linux-setup-gets-a-network-namespace-of-its-own-through-a-user-mode-network-stack.md) (pasta comes before slirp4netns where its resolver works, and doctor says which stack runs and whether it is isolated) and [0277](0277-slirp4netns-runs-under-its-seccomp-filter.md) (what a taken-over slirp4netns keeps in reach is recorded and accepted for now)

## Context
Since [ADR 0218](0218-a-linux-setup-gets-a-network-namespace-of-its-own-through-a-user-mode-network-stack.md) a repository's setup on Linux and WSL2 gets the network from a user-mode network stack that joins its network namespace from outside: slirp4netns first, pasta where slirp4netns is missing.
The stack runs as the Cellar's user, outside bwrap's sandbox, and parses the packets the setup sends, which are a brewer's, since the setup runs build files a brewer may have written.
[ADR 0277](0277-slirp4netns-runs-under-its-seccomp-filter.md) put slirp4netns under its seccomp filter, but not its own sandbox, which needs uid 0 in the setup's user namespace.
So a slirp4netns taken over through a libslirp memory-safety flaw keeps in reach the user's home folder, with gh's `hosts.yml` where gh keeps its login in a file, and `/run/user/<uid>/bus`, the D-Bus session socket through which the Secret Service hands out the keyring's logins.
That path needs a working libslirp exploit; none is known (#705).

The owner is the check sandbox, the row "A check step running code a brewer wrote" in [`docs/trust-boundaries.md`](../trust-boundaries.md).
This improves that owner and adds no layer: it chooses between the two stacks it already starts.

The tools' own documentation and code, read for this record on 2026-11-14:

- **passt** ([passt.top, Security](https://passt.top/passt/about/)): "with default options, user, mount, IPC, UTS, PID namespaces are detached".
  pasta(1)'s `--chroot-fallback` says pasta uses `pivot_root()` "to switch to an empty filesystem for stricter isolation", and that the whole sandboxing fails when it fails.
  Given a PID, pasta "associates to an existing user and network namespace"; the page names no option that keeps the mount namespace or the pivot, and Foedrum passes none (`-f` keeps only the PID namespace).
  `--dns-host` defaults to "the first nameserver from the host's /etc/resolv.conf", which `--dns-forward` maps the namespace's resolver address to.
- **slirp4netns** ([sandbox.c](https://github.com/rootless-containers/slirp4netns/blob/master/sandbox.c), [main.c](https://github.com/rootless-containers/slirp4netns/blob/master/main.c), slirp4netns(1)): `--enable-sandbox` unshares a mount namespace, keeps `/etc` and `/run` read-only from the host, pivots and drops capabilities; before that, a slirp4netns that is not root joins the target's user namespace and calls `setegid(0)` and `seteuid(0)`, which fails where bwrap maps the Cellar's uid to itself (ADR 0277).
  It joins the target's network namespace by opening `/proc/<pid>/ns/net`, or a path with `--netns-type=path`.
- **Rootless Podman** ([pasta_linux.go](https://github.com/containers/common/blob/main/libnetwork/pasta/pasta_linux.go)) and **RootlessKit** ([pasta.go](https://github.com/rootless-containers/rootlesskit/blob/master/pkg/network/pasta/pasta.go)) start pasta with `--config-net` and the target, and pass no option that changes its sandbox.
  RootlessKit's slirp4netns driver adds `--enable-sandbox` and wraps slirp4netns in no mount namespace of its own.
- **user_namespaces(7)** and **setns(2)**: an unprivileged process gets a mount namespace only together with a new user namespace; joining a network namespace needs `CAP_SYS_ADMIN` in the user namespace that owns it, and a process holds capabilities only in its own user namespace and those below it, or as the owner from the parent.

What pasta's resolver did on CI's ubuntu leg (ADR 0218, run of #425): the runner's `/etc/resolv.conf` names only systemd-resolved's stub, 127.0.0.53, and pasta printed `Couldn't get any nameserver address`, so a setup could not look names up.

## Decision

### pasta first, where its resolver works
`setupStack` (`src/platform/check-sandbox.ts`) chooses a setup's stack from the tools on the Cellar's `PATH` and the host's `/etc/resolv.conf`:

| pasta | slirp4netns | pasta's resolver | Stack |
|---|---|---|---|
| there | either | works | pasta |
| there | there | does not work | slirp4netns |
| missing | there | any | slirp4netns |
| there | missing | does not work | pasta, with the resolver gap (ADR 0218's consequence, as before) |
| missing | missing | any | none: the setup is unstarted, as before |

- **"Its resolver works"** (`pastaResolverGap`): the first `nameserver` line of the host's `/etc/resolv.conf` names an IP address that is not a loopback address (127.0.0.0/8, `::1`; an IPv6 zone such as `%eth0` is left out).
  That is the address pasta forwards 10.0.2.3 to by default.
  A file that cannot be read, that names no nameserver, or whose first one is not an address does not work.
  The test is read on the text before each setup's stack starts; it asks no resolver.
- **Isolated** is pasta's by design, as its documentation says (Context), and is not checked at run time.
  The integration test proves it for Foedrum's arguments on CI's ubuntu leg (Consequences).
- pasta's and slirp4netns's arguments do not change.

### Doctor
On Linux the tools table lists the stack a setup would use, and a line under it says whether it is isolated:

- `Setup network: pasta, isolated (a mount namespace of its own on an empty root, ADR 0400)`
- `Setup network: slirp4netns, not isolated: a taken-over slirp4netns reaches the home folder and /run/user (ADR 0400)`, with `; pasta is here, but <why its resolver does not work>` when pasta was passed over.
- `Setup network: pasta, isolated, but <why>: a setup cannot look names up; install slirp4netns (ADR 0218, ADR 0400)`.
- No line with neither stack, where ADR 0218's problem says what to install, and none off Linux.

Doctor's shell reads `/etc/resolv.conf` on Linux for it; a file it cannot read counts as one pasta's resolver cannot use.

### slirp4netns's gap, accepted for now
Where slirp4netns runs, a taken-over slirp4netns keeps in reach what the Cellar's user reaches through the syscalls its seccomp filter lets through: the home folder, with gh's `hosts.yml`, and `/run/user/<uid>/bus`, through which the Secret Service hands out the keyring's logins.
It is accepted because the path needs a working libslirp exploit sent from a setup's packets, none is known, and slirp4netns is now chosen only where pasta is missing or cannot resolve.
Doctor names it on every machine where it applies.

### Can slirp4netns run in a mount namespace of Foedrum's own?
Found out from the sources above, not run:

- **A plain wrapper cannot.** `unshare -m`, or a second bwrap, gives slirp4netns a mount namespace only inside a new user namespace. From there it holds no capability over the setup's user namespace, a sibling owned by bwrap, so it cannot join the setup's network namespace.
- **slirp4netns's own `--enable-sandbox` would not hide `/run/user`** even where it could start: it keeps `/run` from the host, read-only (sandbox.c).
- **One route looks possible, not checked:** a second bwrap that joins the setup's own user namespace with `--userns <fd>`, which Foedrum, its owner in the parent namespace, may open, with `--cap-add CAP_SYS_ADMIN`, the home folder and `/run` as tmpfs, the host's network namespace kept, running `slirp4netns --netns-type=path /proc/<pid>/ns/net tap0`.
  Whether slirp4netns then skips its own user namespace join, and whether bwrap 0.9 lets `--userns` with `--cap-add`, are not checked.
  Proving it is a follow-up of its own.

### Migration
None.
Nothing a Brewery holds changes, and a working Brewery's setups run as before, on pasta where it is installed and the host names a resolver it can forward to.

## Consequences
- On a Linux Cellar with pasta and a resolver that is not a loopback stub, a taken-over stack no longer reaches the home folder or `/run/user`.
- Desktops whose `/etc/resolv.conf` names only systemd-resolved's stub (Ubuntu's, Fedora's) keep slirp4netns and its gap, and doctor says so.
- CI's ubuntu leg installs `passt` beside `slirp4netns`. The integration test runs a setup through `sandboxedChecks` with each stack as the only one found, and reads the stack's `/proc/<pid>/mountinfo` while the line waits: pasta's has none of the devices of the test's home folder and `/run/user/<uid>` (or `/run`), and slirp4netns's has them, in the test's own mount namespace. It fails instead of skipping on CI when a stack is missing.
- CI's runners name only the stub, so their setup cases still run on slirp4netns; pasta's isolation is proved by the forced case above.
- `docs/trust-boundaries.md`'s check-sandbox row names the gap.

## Alternatives considered
- **Check pasta's isolation before each setup** (start it with `-P`, compare its mount namespace with Foedrum's). It needs a pid file, a read of `/proc` and a failure path for what pasta's documentation and the CI test already show. Rejected.
- **Give pasta a resolver with `--dns-host`**, such as systemd-resolved's upstream list in `/run/systemd/resolve/resolv.conf`, so it works behind the stub too. Whether Ubuntu 24.04's pasta knows the option, and which upstream to take, are not checked; it waits for a case that needs it.
- **Ask the resolver before choosing** (a query through pasta). It sends a query out of the machine before each setup, for a test the file's text answers.
- **Wrap slirp4netns in a sandbox of Foedrum's own.** Out of this record's reach (#705); the route above is its starting point.
- **Keep slirp4netns first.** It leaves the gap open on every machine where pasta would have worked.
