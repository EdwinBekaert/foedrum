# 0010. Cross-platform support and isolation levels

Date: 2026-10-13 · Status: Accepted · Amended by [0039](0039-windows-job-objects-through-a-powershell-helper.md) and [0049](0049-reviewers-read-only-inside-the-checkout.md)

## Context
Foedrum's users work on Windows, macOS and Linux. Brewers run shell commands and edit files inside repositories that may contain untrusted content. Claude Code's OS sandbox restricts **shell commands only** and exists on macOS (Seatbelt), Linux and WSL2 (bubblewrap + socat); on native Windows, shell commands run unsandboxed. File tools, MCP servers and hooks are outside the sandbox on every platform and are controlled by permission rules.

## Decision
- Foedrum supports **Windows, macOS and Linux** as first-class platforms. CI runs every test layer on all three.
- Foedrum defines three **isolation levels** and always reports the effective one:
  - **Sandboxed** (macOS, Linux, WSL2): sandbox enabled per attempt with unsandboxed commands disallowed, writes limited to the worktree, network limited to an allowlist.
  - **Permissions only** (native Windows): strict tool allowlists, file-tool deny rules outside the worktree, minimal environment, `scope` guard; a visible warning.
  - **Container** (optional, any OS with an OCI container runtime — Podman or Docker): `claude` runs in a container that mounts only the worktree.
- A Brewery can require a minimum isolation level; writing brewers refuse to run below it.
- Platform-specific behaviour (process spawning and killing, paths, line endings, file locks, executable lookup) is isolated in small modules with tests on all three platforms. Rules: [architecture §13](../architecture.md#13-platform-support-and-isolation).

## Consequences
- Windows users get a working Foedrum, with weaker isolation unless they use WSL2 or a container; this is stated, not hidden.
- `foedrum doctor` becomes part of setup.
- A three-OS CI matrix costs CI minutes but catches platform bugs before users do.

## Alternatives considered
- **Require WSL2 on Windows:** strongest isolation, but excludes many Windows users and complicates setup.
- **Container-only:** uniform isolation everywhere, but requires a container runtime and complicates subscription login inside the container.
- **macOS and Linux only:** simpler, but excludes a large share of developers.
