# 0414. Attempt settings name no login places: the agent's sandbox hides the person's logins

Date: 2026-11-17 · Status: Accepted · Amends [0087](0087-sandboxed-commands-go-through-the-allow-rules-and-never-see-credentials.md) (the credentials every sandboxed attempt hides), [0160](0160-sandboxed-commands-read-only-inside-the-working-directories.md) (ADR 0087's credentials kept as a second line, the variables that move a login, and doctor's advice), [0162](0162-sandboxed-commands-read-the-toolchain-folders-of-the-driver-s-path.md) (no folder re-opened at, inside or around a hidden login) and [0082](0082-brewers-never-allow-gh.md) (doctor's advice on what each level keeps from gh's login)

## Context
On the sandboxed level, each attempt's settings file named places that hold logins and told Claude Code's sandbox to hide them from a brewer's commands.
ADR 0087 listed 8 files (`~/.config/gh`, `~/.git-credentials`, `~/.config/git/credentials`, `~/.ssh`, `~/.aws`, `~/.npmrc`, `~/.claude/.credentials.json`, `~/.config/anthropic`) and 8 variables (`GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, `GITHUB_ENTERPRISE_TOKEN`, `NPM_TOKEN`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`) in `sandbox.credentials`, and the schema refused a settings file that left one out.
ADR 0160 added the logins `GH_CONFIG_DIR`, `XDG_CONFIG_HOME` and `CLAUDE_CONFIG_DIR` move, read from serve's environment and passed through the attempt plans and `foedrum resume`, and kept the list as a second line under `permissions.blockReadsOutsideWorkingDirectories`.
ADR 0162 kept the toolchain folders it re-opens away from every path of that list.
Doctor's advice named what the sandbox hides, the Windows user's logins under `/mnt` on WSL2, and what its docs leave open about the OS keyring.

ADR 0160 already said it: "A list of paths can't be complete."
Every tool keeps a login somewhere, and most can move it with a variable, so a list of places that may hold a secret has no end and cannot be maintained.
The decision that closed #1080 left that job to the agent's sandbox, and the maintainer decided on 2026-11-17 that the attempt settings follow it (#1126).

## Decision
- **Foedrum hides from a brewer's commands the agent keys it passes to claude, and names no login place.** `sandboxCredentials` and the schema's check that a settings file hides every entry of it are gone. `brewerBaseEnv` passes every `ANTHROPIC_*` variable on to claude (`isAgentVariable`, `src/engine/brewer-env.ts`), and a sandboxed command inherits claude's environment ("Inherited from Claude Code, including any secrets in its environment", as ADR 0087 quotes the docs), so an `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` serve has would reach it (review of #1138).
  `attemptPermissions` takes the names of those variables in the brewer's base environment, and `attemptSettings` writes `sandbox.credentials` with `files: []` and one `deny` entry per name in `envVars`, only when there is one; the names come from what Foedrum passes, never from a list.
  The schema takes no file entry there, and at least one variable (`AttemptSettings`, `src/schemas/attempt-settings.ts`).
- **No variable moves an entry.** `CONFIG_DIRS`, `ConfigDirs`, `configDirsOf`, `movedLogins` and `credentialsOf` are gone (`src/brewers/attempt-settings.ts`), and serve, the attempt plans and `foedrum resume` pass nothing for them.
- **Keeping a brewer's commands from the person's logins is the agent's sandbox's job.** Foedrum turns that sandbox on, with `permissions.blockReadsOutsideWorkingDirectories`, which hides the home folder and the other user folders (ADR 0160, unchanged).
- **Foedrum keeps its own rules**, which this ADR does not change: `brewerBaseEnv` passes no GitHub token, so those variables never reach a brewer to be hidden; the allow rules give a brewer no `gh` ([ADR 0082](0082-brewers-never-allow-gh.md)); [ADR 0109](0109-a-brewer-s-git-holds-no-push-credential.md)'s git switches stop a push; the push scan ([ADR 0079](0079-the-push-scans-the-batch-s-commits-for-secrets.md)) and the post filters ([ADR 0088](0088-out-doc-text-that-looks-like-a-secret-is-left-out-of-the-pull-request-and-the-status-comment.md)); and doctor names the level.
- **The toolchain folders (ADR 0162).** `toolchainReads` re-opens Homebrew's prefix on Linux, a layout's prefix (nvm's version, `~/.volta`, `~/.asdf`), and any other PATH folder under the home as it is, whatever it holds: the PATH is the person's own.
  It never re-opens the home itself, a PATH folder's parent, a relative or empty entry, an entry that leaves the home through `..`, or a folder with a glob character, as before.
  npm's configuration files stay denied inside each re-opened folder (`denyRead`, ADR 0162): a prefix's `etc/npmrc` lies inside a folder Foedrum itself re-opens, so the deny is part of the re-open, not of a list.
- **Doctor's advice says what Foedrum does** and points to Claude Code's sandboxing docs (https://code.claude.com/docs/en/sandboxing) for what the sandbox hides.
  On the sandboxed level it reads: "Claude Code's sandbox limits what a brewer's commands read: see its sandboxing docs, https://code.claude.com/docs/en/sandboxing.", then the push scan and the post filters, then where check steps run.
  On a permissions-only level it keeps "A brewer runs as you here" (on native Windows "A brewer or a check step runs"), names the sandboxed level it can have ("On the sandboxed level (bubblewrap and socat), …", "In WSL2, on the sandboxed level, …") with the same pointer, and the same last two sentences.
  `SANDBOX_HIDES`, `WSL2_WINDOWS_HOME` and the keyring sentence are gone (`src/cli/doctor.ts`).

### Tests
Unit: `test/unit/attempt-settings.test.ts` ('writes a sandbox block that names no login place', 'hides from sandboxed commands the agent keys the driver passes to claude', 're-opens a PATH folder under the home as it is, whatever login it may hold', 'accepts a sandbox block that names no login place', 'refuses a sandbox block that names login places, and writes nothing', 'accepts a sandbox block that hides the agent keys by name'), `test/unit/attempt-plan.test.ts` ('hands the attempt settings the names of the agent keys the driver passes to claude', and none when it passes none), `test/unit/resume.test.ts` ('writes the settings again hiding the agent keys serve passes to claude'), `test/unit/doctor.test.ts` ("points to Claude Code's sandboxing docs on every level that runs or advises its sandbox", 'names no place the sandbox hides on any level') and `test/unit/cli.test.ts`'s snapshot; `test/integration/doctor.test.ts` holds the report's lines.
The tests of ADR 0087's list, of ADR 0160's moved logins and of ADR 0162's folders at, inside, around or beside a login are removed with the code.

## Consequences
- Which logins a brewer's sandboxed commands can still reach is what Claude Code's sandbox docs say, and Foedrum's docs no longer repeat it.
- A login outside the user folders, in a file the block re-opens (git's global configuration), or in the cases where the docs say the block does not reach sandboxed commands, is no longer hidden by a second entry of Foedrum's: ADR 0160's "What stays open" now holds without ADR 0087's list under it.
- Claude's own login file, under a CLAUDE_CONFIG_DIR outside the user folders or wherever the re-open of ~/.claude reaches it, is no longer denied by Foedrum.
- A PATH folder under the home that holds a login (`~/.config`, `~/.ssh/bin`) is re-opened when it is on serve's PATH; a Brewery keeps no such folder on its PATH.
- The settings file of a sandboxed attempt is shorter by the list; of serve's environment, only the agent variables it passes on add an entry, one per name.
- Claude itself still reads those variables: the deny applies to the commands a brewer runs in the sandbox, not to claude's own process.
- **Migration:** none. Attempt settings are written per attempt; no Brewery file changes.

## Alternatives considered
- **Keep the list and add to it** (ADR 0087, ADR 0160): it has no end, and each entry is one more place to keep in step with a tool Foedrum does not own.
- **Re-open only `bin` and `sbin` folders and the layouts:** a new rule with no failure behind it, kept out of the toolchain folders only for a folder the person put on their own PATH.
- **Keep doctor naming what the sandbox hides:** it repeated the sandbox's docs in Foedrum's words and went stale with every change there.
