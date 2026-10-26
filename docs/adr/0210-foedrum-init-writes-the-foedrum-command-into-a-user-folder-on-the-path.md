# 0210. `foedrum init` writes the `foedrum` command into a user folder on the PATH

Date: 2026-10-26 · Status: Accepted · Amends [0207](0207-foedrum-init-creates-the-brewery-s-repository-labels-the-targets-and-pushes.md) (init offers the `foedrum` command after the push, before doctor)

## Context
Until the package is on npm (M3, [ADR 0016](0016-delivery-npm-cli-and-companion-plugin.md)), `foedrum` is not a command on the PATH: after [ADR 0207](0207-foedrum-init-creates-the-brewery-s-repository-labels-the-targets-and-pushes.md)'s `foedrum init`, the user runs it as `node <checkout>/src/cli/main.ts`. The maintainer settled on #404 (2026-10-25) that init writes a small `foedrum` command, a shim, after asking, into a user folder already on the PATH, listing the folders it found, and says which folder to add when there is none; after M3, `npx foedrum` replaces it. This is #529.

## Decision

### When
After the commit and push and before doctor, so doctor's report follows it; whether init created the Brewery or ran in its clone. It is asked once.

### Where
- The folders it offers are those of the PATH (`pathFolders`, as `resolveExecutable` reads them, PATH's case-insensitive name on Windows) that lie inside the user's home (`os.homedir()`, the user profile on Windows), exist as folders and are writable, each once.
- `WindowsApps` is never offered: Windows keeps its app execution aliases there, and the folder is the system's, not the user's.
- They are listed numbered, in this order: `<home>/.local/bin` and `<home>/bin`, the folders users keep their own commands in; then the other folders in PATH order; then, in PATH order, the folders a tool manages, which move or vanish with the tool: npm's global prefix (`AppData/Roaming/npm`, `.npm-global`), an nvm version's or nvm's folder (`.nvm`, `nvm`), Python's (`Scripts`, a `Python<n>` folder, `.pyenv`) and `.cargo`. They are told apart by plain path patterns, without asking any tool. npm's folder is also where `npm install --global foedrum` puts its own `foedrum` after M3, so a shim there would stand in its way.
- The question is `Write the foedrum command into which folder? [1, or n for none]`: an empty answer takes the first, a number another one listed, `n` none; any other answer is asked again.
- Never a folder outside the home, so never a system folder, and never one that is not on the PATH already. A home that is a root folder (`/`, `C:\`) offers none, since every folder would lie inside it.
- When there is none, init writes nothing and says which folder to create and how to add it to the PATH: `~/.local/bin` with the line `export PATH="$HOME/.local/bin:$PATH"` for the shell's profile on Linux and macOS; `%USERPROFILE%\.local\bin` with the PowerShell line that appends it to the user's `Path` on Windows. When `<home>/.local/bin` or `<home>/bin` is on the PATH but not made yet, as some shell profiles set it, init says only to create it. The PowerShell line writes a `'` in the folder as `''`. Then it prints the shim, as for a no.

### What
- On Linux and macOS, `foedrum`, a `#!/bin/sh` script of mode 0755 that runs `exec node '<checkout>/src/cli/main.ts' "$@"`.
- On Windows, `foedrum.cmd`, which runs `node "<checkout>\src\cli\main.ts" %*` after `setlocal` and `set "NoDefaultCurrentDirectoryInExePath=1"`, so cmd never runs a `node` from the folder the user is in (a brewer's worktree or a target's clone may hold one), as Foedrum's own runner does for every `.cmd` ([ADR 0031](0031-cmd-and-bat-files-through-cmd-exe.md)), with CRLF line ends; only when PATHEXT has `.CMD` (the default), since without it `foedrum` does not find the file: init says so and writes nothing.
- Each has a comment line that says init wrote it, by which init knows its own shim again.
- `node` is the one on the PATH, as `main.ts`'s own `#!/usr/bin/env node` runs and as npm's shims will after M3, not this process's `process.execPath`: a Node upgrade, an nvm switch or a Homebrew keg moves that path, and the shim would break with it.
- The checkout is the one of the Foedrum that runs, from `main.ts`'s own location (`import.meta.url`), never the working directory, which is the Brewery's.
- The path is always quoted: in single quotes on POSIX (a `'` in it written as `'\''`), in double quotes on Windows, where no path holds a `"`, with each `%` doubled so cmd does not read it as a variable.

### A shim already there
- Init looks for its command in each folder it would offer, in their order, before asking.
- One of init's shims that runs this checkout is named and kept, without a question.
- One that runs another checkout is named in the question `<file> runs the Foedrum in <other>. Point it at <this>? [y/N]`, default no; a no keeps it.
- A file there that is not one of init's shims is never written over: init says so in one line and writes nothing, since it is someone else's `foedrum`.

### A no
A file it cannot read or write there (a folder by that name, a Windows ACL that `writable` does not see) is said in one line with the system's message, and init prints the shim as for a no and goes on to doctor.

A no prints where the shim would go and what it would hold, line by line, and on Linux and macOS the `chmod 755` it needs, so the user can write it by hand.

### After it
Init says whether `foedrum` now runs the shim in this terminal (`resolveExecutable`). Every folder it writes to is on the PATH already, so a new terminal finds it; when an earlier folder of the PATH has another `foedrum`, init names it, since that one runs instead.

## Consequences
- After `foedrum init`, a new terminal runs `foedrum doctor` on a machine whose PATH has a user folder; on one without, init says the two steps that make one.
- The shim follows the checkout: a `git pull` there updates the `foedrum` the shim runs, and moving the checkout breaks it until init runs again.
- After M3, init stops writing the shim, and a shim left in npm's folder would meet `npm install --global foedrum`: the ordering puts that folder last for this reason.

## Alternatives considered
- **Offer the first folder in PATH order, yes or no:** on a typical machine that is Python's `Scripts` folder or an nvm version's `bin`, which a tool owns and removes.
- **Run `process.execPath`:** right for the node that runs init today, wrong after the next Node upgrade.
- **Also write a `foedrum` sh script on Windows, for Git Bash:** a second file to keep in step for a shell that native Windows ([ADR 0010](0010-cross-platform-and-isolation-levels.md)) does not need: PowerShell and cmd run `foedrum.cmd`.
- **Add a folder to the PATH itself:** a change to the user's shell profile or registry that init cannot undo; saying the line keeps that change the user's.
- **Write the shim into a system folder (`/usr/local/bin`) with elevation:** a prompt for a password, and a file outside the home init would own.
