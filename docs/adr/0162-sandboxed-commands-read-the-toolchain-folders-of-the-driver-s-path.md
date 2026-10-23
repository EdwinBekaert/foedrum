# 0162. Sandboxed commands read the toolchain folders of the driver's PATH

Date: 2026-10-23 · Status: Accepted · Amends [0160](0160-sandboxed-commands-read-only-inside-the-working-directories.md) (its consequence that a toolchain under the home is unreadable, and that Foedrum writes no `allowRead`)

## Context
Since [ADR 0160](0160-sandboxed-commands-read-only-inside-the-working-directories.md), the attempt settings of the sandboxed level (macOS, Linux, WSL2) turn on `permissions.blockReadsOutsideWorkingDirectories`. Sandboxed commands then lose the home directory and the other user roots, so a toolchain installed under the home is unreadable to them. That covers node from nvm, Volta or asdf, tools in `~/.local/bin`, and Homebrew on Linux, whose prefix `/home/linuxbrew/.linuxbrew` lies under `/home`. An allowed `npm test` fails there (#427).

Claude Code's documentation, read for this ADR on 2026-10-23 ([Settings reference](https://code.claude.com/docs/en/settings-reference): "Sandboxed commands under the block", `sandbox.filesystem.allowRead`, "Sandbox path prefixes"; [Sandboxing](https://code.claude.com/docs/en/sandboxing): "Configure sandboxing", "Protect credentials", "Locks that apply without an admin-required sandbox"), says:

- **`allowRead` re-opens what a read rule denies.** It is the setting to "Re-open reading for specific paths inside a region that `denyRead` blocks". Under the block, "`allowRead` and `allowWrite` entries from repository settings don't count". The runner's `--settings` file is not repository settings ([ADR 0046](0046-only-the-runners-settings-the-init-check-and-a-line-by-line-stream.md)), so its entries count.
- **The narrower rule wins.** "When read rules overlap, the rule with the narrower path applies": with `"denyRead": ["~/"]` and `"allowRead": ["~/projects"]`, "`~/projects` is readable". But with `"allowRead": ["~/"]` and `"denyRead": ["~/.env"]`, "`~/.env` stays blocked [...]. The deny holds inside a wider allow, so a broad allow can't silently re-expose a secret". The same holds for a wildcard deny. "An exact or wildcard `denyRead` entry stays blocked inside a broader `allowRead`."
- **Credentials are read denies.** For a `credentials.files` entry with `"mode": "deny"`, "file paths are denied for reads inside the sandbox, the same restriction that `filesystem.denyRead` applies".
- **The locks do not cover the runner's own entries.** A `credentials.files` entry in `--settings` makes Claude Code ignore an `allowRead` entry at or under the path it denies only "in a repository's settings". The runner's own `allowRead` must therefore keep clear of the logins itself.
- **Paths.** "`/` Absolute path from filesystem root", "`~/` Relative to home directory", a trailing slash and a trailing `/**` are stripped. "`denyRead` and `allowRead`: wildcards work on every platform", so a `*`, `?` or `[` in a path is a wildcard, not a name.
- **Links.** The docs say how a denied path through a link is handled on macOS ("the sandbox also denies the path's real location"), and that on Linux and WSL2 a git configuration file that is a link "can stay unreadable at its own path". They say nothing of an `allowRead` whose folder holds a link to a path outside it. Foedrum reads it as the cautious case: the target stays as readable as it was, so denied when it lies under a user root.

## Decision

### Which folders
`attemptSettings` writes `sandbox.filesystem.allowRead` on the sandboxed level, with these folders, each once, in PATH order (`src/brewers/attempt-settings.ts`):

| PATH folder | Re-opened | What it holds |
|---|---|---|
| `~/.nvm/versions/node/<v>/bin` | `~/.nvm/versions/node/<v>` | That node version: `bin` with node and its links to npm and npx, and `lib/node_modules` with npm, npx and the global packages they link to. Not the rest of `~/.nvm` (nvm's scripts, its download cache, the other versions) |
| `~/.volta/bin` | `~/.volta` | Volta's shims, and the node, npm and packages they run from `~/.volta/tools` |
| `~/.asdf/shims`, `~/.asdf/bin` | `~/.asdf` | asdf itself, its plugins, its shims, and the versions under `~/.asdf/installs` the shims run |
| `/home/linuxbrew/.linuxbrew/bin`, `…/sbin` | `/home/linuxbrew/.linuxbrew` | Homebrew on Linux: its formulae, their links and the Cellar they point into |
| any other folder under the home (`~/.local/bin`, `~/bin`, `~/.cargo/bin`, `~/go/bin`) | the folder itself | the programs in it |

- **Never a PATH folder's parent blindly.** `~/bin`'s parent is the home itself, `~/.local` holds `~/.local/share/keyrings`, and `~/.cargo` holds crates.io's `credentials.toml`. Only the layouts in the table go up, and only to a prefix that holds no login.
- **From the driver's environment.** The folders come from `HOME` and `PATH` in the brewer's base environment, which serve takes from its own (`toolchainOf`, `brewerBaseEnv`). A brewer's own `env` cannot set either, since the brewer schema reserves both names. The planned attempt and `foedrum resume` pass them on.
- **Never re-opened:** the home itself; an entry that is relative, empty, or leaves the home through `..`; a folder whose path holds `*`, `?` or `[`, which the sandbox would read as a wildcard; a folder under another user root (another user's home, the Windows folders under `/mnt` on WSL2), apart from Homebrew on Linux; a folder outside the user roots, which the block does not take; and without an absolute home other than `/`, any folder but Homebrew's prefix on Linux, since `~/` would expand to the home of whichever process reads it.
- **Never at, inside or around a hidden login.** A folder at or inside a path of ADR 0087's credentials, or of the logins ADR 0160's variables move, would be the narrower rule and re-open it. A folder around one (`~/.config`, `~/.claude`) would re-open everything else kept there. Both are left out.

### What stays hidden inside a re-opened folder
- **The credential denies still win.** A re-opened folder is wider than any login inside it, and "the deny holds inside a wider allow". ADR 0087's `credentials.files` entries and ADR 0160's moved logins are written next to `allowRead`, unchanged, and are "the same restriction that `filesystem.denyRead` applies". No re-opened folder can be narrower than one, by the rule above.
- **The block still applies to the rest of the home.** Each entry re-opens its folder and nothing above or beside it.

### What stays unreadable
- **A link to a target outside the re-opened folder.** The re-open reaches the folder, not where its links lead. npm in nvm links to `../lib/node_modules/npm/bin/npm-cli.js`, which the version's folder holds, so it runs. But tools that pipx or uv put in `~/.local/bin` link into `~/.local/share/pipx` or `~/.local/share/uv`, and rustup's proxies in `~/.cargo/bin` read `~/.rustup`. Those stay denied.
- **fnm.** Its PATH folder `~/.local/state/fnm_multishells/<id>/bin` (`~/Library/Caches/fnm_multishells/<id>/bin` on macOS) is a link into `$FNM_DIR/node-versions/<v>/installation`. `FNM_DIR` is not in the brewer's base environment, and its default differs by platform (`~/.local/share/fnm`, `~/Library/Application Support/fnm`, `~/.fnm`). The fallback re-opens the link's folder, and its target stays denied. A Brewery that uses fnm installs node with nvm, Volta or asdf, or outside the home.
- **A user-level npm cache** (`~/.npm`). It is not re-opened. Sandboxed commands could not write to it before ADR 0160 either, and `npm test` runs without it.
- **A toolchain that is not on the driver's PATH** (a version manager loaded only by an interactive shell's profile, which serve's environment never ran).

### Not proven by a run
The proof run #427 asks for needs macOS, Linux or WSL2, which no session on this work has had. That run is an `npm test` with node from nvm, denied without this change and running with it. Like ADR 0087's and ADR 0160's sandbox blocks, what `allowRead` does to sandboxed commands is the docs', not a run's. The sandboxed level's first run checks it, with the commands in the pull request of #427.

### Tests
Unit only: `test/unit/attempt-settings.test.ts` covers each layout of the table, any other folder as it is, each folder once, nothing outside the home but Homebrew on Linux, the entries never re-opened, no folder at, inside or around a login, the credentials kept, nothing without a home, a PATH or a sandbox, and `toolchainOf`. `test/unit/attempt-plan.test.ts` and `test/unit/resume.test.ts` cover the base environment reaching the settings.

## Consequences
- On the sandboxed level, an allowed command reads, besides what ADR 0160 lists, the toolchain folders of the driver's PATH: node from nvm, Volta or asdf, Homebrew on Linux, and the programs in any other PATH folder under the home.
- What those folders hold becomes readable to every sandboxed command: global npm packages, asdf's plugins, Homebrew's Cellar. None is a login Foedrum knows of. A Brewery that keeps a secret in a folder on its PATH under the home must move it.
- The settings file of a sandboxed attempt grows by one `sandbox.filesystem.allowRead` list when the PATH holds such a folder, and by nothing otherwise.
- ADR 0160's "A Brewery on this level installs its toolchain outside the home" now holds only for the cases under "What stays unreadable".

## Alternatives considered
- **Each PATH folder's parent:** re-opens the home for `~/bin`, keyrings for `~/.local/bin`, and crates.io's token for `~/.cargo/bin`.
- **Each PATH folder as it is, no layouts:** nvm's npm, Volta's shims and asdf's shims would still fail, since what they run lies beside their folder.
- **Resolve each PATH folder's real path when the settings are written** (it would cover fnm and pipx): it adds a filesystem read to building the settings, which today is a pure function of the plan, for the one layout the table cannot name. The same goes for **guessing fnm's default folders per platform**, which also misses a moved `FNM_DIR`.
- **A Brewery setting that lists folders to re-open:** a new configuration surface for what the driver's PATH already says, and one more way to re-open a login by mistake.
- **Leave it to the Brewery** (ADR 0160): every Brewery on a machine with nvm or Volta, the common case for node, would fail its first `npm test`.
