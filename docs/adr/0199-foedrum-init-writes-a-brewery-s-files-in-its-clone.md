# 0199. `foedrum init` writes a Brewery's files in its clone

Date: 2026-10-25 · Status: Accepted · Amends [0019](0019-interactive-sessions-and-one-command-layer.md) (`init` is a registry command that appends nothing) and [0125](0125-the-foedrum-plugin-is-markdown-skills-that-run-the-terminal-with-via-plugin.md) (`init` is marked terminal-only until `/foedrum:init`)

## Context
A Brewery was set up by hand: for #374 that took eight steps and several checks of the files against their schemas (#404). [ADR 0019](0019-interactive-sessions-and-one-command-layer.md) lists `init` among the commands, and M3's exit criterion is `npx foedrum init` on Windows, macOS and Linux. The maintainer settled the questions and their defaults on #404 (2026-10-25), and split the work in two: this record is `foedrum init` on the terminal writing a Brewery's files in an existing clone and running `foedrum doctor`; creating the repository on GitHub, the intake labels in the target repositories, the `foedrum` shim on the PATH, the commit and push of the files, and `/foedrum:init` are #512.

## Decision

### A command of the registry, terminal-only for now
- `init` is a command of the registry (`InitCommand`) with no arguments. It appends no events and opens no store ([ADR 0030](0030-only-commands-that-change-state-are-recorded.md)): it writes files, which are the Brewery's own and go to git, not to the event store.
- It is marked terminal-only, with the reason that it asks its questions on the terminal until `/foedrum:init` asks them in a session (#512), which removes the mark ([ADR 0125](0125-the-foedrum-plugin-is-markdown-skills-that-run-the-terminal-with-via-plugin.md)).
- It runs in the Brewery's clone, the working directory as for every command; a folder without `.git` is refused with one line, before any question.

### What it asks
In this order, each with a default an empty answer takes, and each answer checked against its schema, asked again with the schema's message when it does not pass:
1. **The Brewery's name** (`owner/name`): default the `brewery` of the `foedrum.jsonc` already there, else `<login>/foedrum-brewery`, the login gh uses ([ADR 0073](0073-github-only-through-gh-s-own-login.md)).
2. **The target repositories**, `owner/name` separated by spaces: default those of the `foedrum.jsonc` already there, else none.
3. **Per new target repository**, its alias (default its name in lower-case letters and digits, at most 20, starting with a letter) and, when its checks are not read from `package.json`, each of the five checks (empty for none).

Whether the repository is private or public is asked by #512, which creates it: in an existing clone, it already exists.

### What it reads
- From GitHub, through gh's own login (ADR 0073): the login, and per new target repository its default branch, which becomes `base`, and whether it has a `package.json` and a `package-lock.json` on that branch.
- **For Node** (a `package.json`): each check is `npm run <name>` when the scripts have one by that name (`build`, `typecheck`, `lint`, `format`), and `npm test` for a `test` script; a missing one is `null`. The repository's `setup` is `npm ci` with a 10-minute timeout when there is a lockfile.
- A target repository already in the `foedrum.jsonc` keeps its entry as it is: nothing is read or asked for it.

### What it writes
Every file is built whole, checked against its schema, and only then written; a file that would not pass is a bug, and refuses the command with the schema's message, before anything is written.
- **`foedrum.jsonc`** (`BreweryConfig`): `brewery`, `users` with the login, `concurrency` 1, and per target repository its `alias`, `intake` with the label `foedrum:brew`, `source` `managed` (Foedrum's branches and worktrees never land in the user's own clone, ADR 0012), `base`, `checks` and `setup`; for Node, each check as a `tools` rule `Bash(<command>)`, so a brewer can run the checks before it commits (ADR 0163), and the `permissionCeiling` the union of those rules ([ADR 0026](0026-how-a-permission-ceiling-covers-a-rule.md)). Keys the file already has and init does not ask about are kept.
- **`models.jsonc`** (`ModelsConfig`): no aliases of its own, so every alias is Foedrum's default ([ADR 0153](0153-foedrum-s-defaults-map-their-own-model-aliases.md)), with a comment that says how to map one.
- **`.gitignore`**: a line `.foedrum/`, the event store and the machine's own files (ADR 0063), added to the lines already there.
- **`.claude/settings.json`** (`BreweryClaudeSettings`, the keys init writes): `"enabledPlugins": { "foedrum@foedrum": true }`, merged into the settings already there.

### Existing files
- A file that is not there is written. A file whose content would not change is left alone and named as up to date.
- A file that would change is never written without asking: init lists what would change (the keys, by path, or the line it would add) and asks once per file, default no. A no keeps the file as it is.
- So a second run, with the same answers, lists nothing to change and writes nothing; with other answers it lists exactly what they change.
- A `foedrum.jsonc` or `.claude/settings.json` that does not read as JSON(C) is named with its reason, and replacing it is asked as for any change.

### At the end
- It runs `foedrum doctor` in the clone and shows its report; init's exit code is doctor's, so a machine that is not ready yet ends in 1 after the files are written.
- It prints the two commands each machine runs once for the plugin: `claude plugin marketplace add EdwinBekaert/foedrum` and `claude plugin install foedrum@foedrum --scope project`.

## Consequences
- A new Brewery's files take one command and a few answers, checked against the schemas by construction, instead of eight steps.
- Running init again is safe: it reports what it would change and asks before each file.
- `foedrum.jsonc` written over an existing one loses its comments; the question says so.
- Until #512, the user creates and clones the repository, creates the intake labels, commits and pushes the files.
- `$schema` is not written: the schemas are not in the Brewery's checkout until the package carries them (M3).

## Alternatives considered
- **Read the Brewery's name from the clone's `origin`:** one more git call and a URL to parse in every form git takes; the default from gh's login is right for a new Brewery, and a second run takes the name from `foedrum.jsonc`.
- **Ask about every key** (concurrency, poll interval, source, test report): more questions for keys whose defaults fit a first Brewery, which the user edits later.
- **Write over existing files with a backup:** a second run would always write; asking keeps the user's file unless they say yes.
- **Exit 0 whatever doctor says:** the files are written either way, but a 0 would say the Brewery is ready when doctor says it is not.
