# 0415. A release bump also refreshes a Cargo.lock and a NuGet packages.lock.json

Date: 2026-11-17 · Status: Accepted · Amends [0412](0412-foedrum-refreshes-and-commits-the-npm-lockfile-a-release-bump-leaves-behind.md) (which lockfiles: Cargo's and NuGet's beside npm's, a Cargo.lock found above its manifest and NuGet's below a `Directory.Packages.props`; the commit's message names no lockfile; Cargo and NuGet leave its "Left out")

## Context
ADR 0412 refreshes the npm lockfile a release bump leaves behind, and left Cargo's and NuGet's to #1127.
A Rust or .NET repository that pins a dependency by tag and keeps a lockfile still gets a pull request whose lockfile lags behind its manifest.
Two of their lockfiles are not beside the manifest that changed:
- Cargo: "All packages share a common `Cargo.lock` file which resides in the workspace root", and from a member's folder Cargo "will automatically search the parent directories for a `Cargo.toml` file with a `[workspace]` definition" (Cargo Book, Workspaces).
- NuGet: with central package management, MSBuild "will only automatically import the first `Directory.Packages.props` file it finds in the project directory or any parent directory" (Microsoft Learn, Central Package Management), so a changed props changes the packages of every project below it, which the changed paths do not name.

## Decision
- **Cargo.** For each `Cargo.toml` the attempt's commits changed, as the system map reads one (outside `node_modules`, `vendor` and a `target` folder, ADR 0320), the nearest `Cargo.lock` from its folder up to the repository's root, when the tree holds it as a regular file.
  The command is `cargo update --workspace`, run in that lockfile's folder.
  Cargo's documentation says `--workspace` "is useful for updating `Cargo.lock` after you've changed version numbers in `Cargo.toml`", and other packages "are updated only if they don't already exist in the lockfile".
  It runs no build script: Cargo compiles and runs `build.rs` "just before building the package" (Cargo Book, Build Scripts), and `cargo update` builds nothing; its page says only that it updates `Cargo.lock`.
- **NuGet, a project.** For each changed `*.csproj`, `*.fsproj` or `*.vbproj` outside `bin`, `obj` and `node_modules`, the `packages.lock.json` beside it, where NuGet writes it ("at the project root directory", Microsoft Learn, Locking dependencies).
  The command is `dotnet restore "<project>"`, in its folder, naming the project because a folder may hold a solution beside it, and `dotnet restore` with no file "searches the current directory for a project or solution".
  A project whose name a shell line cannot quote alike in `/bin/sh` and cmd.exe (the test the checks before a brewer's end use, ADR 0381) is left out.
  No `--force-evaluate`: it is for floating versions, and restore already "re-evaluates the package graph and updates the lock file" when the project's dependencies changed.
- **NuGet, a `Directory.Packages.props`.** For each changed one, every `packages.lock.json` in its folder and the folders below, beside the one project of its folder, restored as above.
  The walk passes over `bin`, `obj`, `node_modules` and `.git` in any case, and does not follow a link or a junction.
  A folder it cannot read ends the attempt `blocked`, `environment`: `the lockfiles could not be refreshed: <why>` (ADR 0412), rather than leave a lockfile stale unseen.
  A folder with two projects is passed over: NuGet names their lockfiles `packages.<project_name>.lock.json`.
  A project below a deeper props is restored too; its dependencies did not change, so its lockfile stays as it was.
- **Once each.** A lockfile two changed manifests lead to, such as a workspace's for two members, is refreshed once.
- **The commit's message** is `Refresh the lockfiles after the release bump (ADR 0412)`: which lockfiles a refresh finds is known only in its scratch tree, after the message is given; the commit's diff names them.
- Everything else is ADR 0412's: the scratch tree, the setup's sandbox with the network, the 5-minute limit, the readings, and the commit only when every refresh passed.
- **Not overridden:** a repository that sets `RestoreLockedMode` to true where restore runs fails it ("restore will … fail if you updated the defined package dependencies"), and the batch goes Stuck on its environment, naming the lockfile.

## Security
`dotnet restore` evaluates the project's MSBuild files, so a `Directory.Build.targets` a brewer wrote runs, as ADR 0158 already names for a setup's `dotnet restore`.
It runs in the same sandbox, with the same environment, as the setup does before every brewer attempt (ADR 0163).
`cargo update` builds nothing, so it runs no build script; it still reads the repository's Cargo configuration (`.cargo/config.toml`), which a brewer can write and which can name programs Cargo starts, such as a registry's credential provider.
Those run in the same sandbox and environment as the setup and `dotnet restore`.
So no row of [docs/trust-boundaries.md](../trust-boundaries.md) gains a risk, and no safeguard is added.
The project's name goes into the command line only when it passes the quoting test; that is the command's own correctness, not a safeguard.

## Consequences
- A Rust or .NET repository that pins a dependency by tag and keeps a lockfile gets it refreshed in the bump's pull request.
- **A toolchain under the home folder is not found.** rustup installs `cargo` in `~/.cargo/bin` and the .NET install script in `~/.dotnet`; the setup's sandbox hides the home folder (ADR 0158), so there the refresh reads `not found` and the batch goes Stuck on its environment, naming the lockfile.
  The repository's checks need the same toolchain outside the home folder already (ADR 0076).
  `CARGO_HOME` (default `$HOME/.cargo`, the registry index and git checkouts) and NuGet's global packages folder (default `~/.nuget/packages`) land in the sandbox's empty home, so each refresh downloads what it resolves, as npm's does.
- **Not checked:** whether a cold `dotnet restore` or `cargo update` of a large repository fits in the 5 minutes, and whether either reaches a tag on GitHub from inside the sandbox; when not, the batch goes Stuck on its environment, naming the lockfile.
- **Brewery migration:** none. A repository with no lockfile gets none.

## Alternatives considered
- **A refresh for every folder from the manifest up.** No change to the refresh's lookup, but every outer folder holding a `Cargo.lock` would be refreshed, not only the workspace's.
- **`dotnet restore` in the folder with no project named.** Simpler, but a folder holding a solution beside its project, a common layout, is ambiguous to MSBuild.
- **Leave `Directory.Packages.props` out.** Central package management is where a .NET repository bumps a version, so its pull request would keep the stale lockfiles.
- **Pass `-p:RestoreLockedMode=false`.** It would refresh a repository that locks restore everywhere, overriding its own choice; no such failure has been seen.
