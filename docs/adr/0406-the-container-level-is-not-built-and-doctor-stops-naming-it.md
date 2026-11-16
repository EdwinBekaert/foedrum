# 0406. The container level is not built, and doctor stops naming it

Date: 2026-11-16 · Status: Accepted · Amends [0010](0010-cross-platform-and-isolation-levels.md) (its third isolation level), [0075](0075-only-a-lower-bound-reads-the-wall-clock-and-doctor-runs-against-stub-tools.md) (doctor's integration case of a container runtime that hangs) and [0082](0082-brewers-never-allow-gh.md) (doctor's sentence that the container level closes both)

## Context
ADR 0010 defined three isolation levels: sandboxed, permissions only, and an optional container level, where `claude` runs in a container that mounts only the worktree.
Only the first two are built: `IsolationLevel` in `src/cli/doctor.ts` is `'sandboxed' | 'permissions only'`, and no code starts a brewer in a container.
Yet `foedrum doctor` told a person on the permissions-only level that "the container level mounts only the worktree, which closes both" (ADR 0082), and reported a Podman or Docker it found as "the container level is available".
It pointed people at a protection they cannot turn on, and no issue plans it (#1074).

Building it is more than a mount:

- **The network.** A container's default network reaches anything the host reaches; the sandboxed level limits a brewer to an allowlist. A container level would need its own network policy to be no weaker than the level it is meant to beat.
- **An image per Brewery.** Each repository's toolchain (Node, .NET, Rust, Go, at the versions it pins) would have to be in the image, built and kept up to date per Brewery.
- **Git worktrees across the mount.** An attempt's worktree points back to its clone's `.git` folder by an absolute path, which a mount of the worktree alone does not hold.
- **The login inside the container.** `claude` needs its own login there, which ADR 0010's alternatives already named as the hard part of a container-only design.

## Decision
- The container level is not built. Foedrum has two isolation levels, sandboxed and permissions only.
- doctor's advice names only what Foedrum does: the sentence that says the container level closes the gaps goes, and the advice still says what can read gh's login on each level.
- doctor no longer probes Podman or Docker and prints no `Container:` line: no person could act on it, and a runtime waiting for its daemon cost doctor up to 3 s. With the probe go its 3 s deadline, ADR 0075's integration case of a runtime that hangs, the stub tools' hang answer and the 3.1 s modelled load only that case needed.
- The level, and the probe with it, come back only with a use case: a team that already brews in containers, with the image and the login it already has.

**Migration:** none. Nothing in a Brewery changes: no file names the container level, and `isolation.minimum` already takes only `sandboxed` and `permissions only` (ADR 0076).

## Consequences
- doctor's report no longer has a `Container:` line, and its advice on the permissions-only level ends with what the sandboxed level hides, where there is one, and where a login a brewer did read is stopped.
- Native Windows without WSL2 has no stronger level to point to than WSL2, which doctor already recommends for untrusted repositories.
- The isolation design page lists the container level as not built, with what would bring it back.

## Alternatives considered
- **Keep the probe and say Foedrum does not use a container yet.** A line no one can act on, at up to 3 s per runtime.
- **Build the container level now.** No user has asked for it, and each point in Context is a design of its own.
