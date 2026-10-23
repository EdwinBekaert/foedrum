# 0031. `.cmd` and `.bat` files start through cmd.exe

Date: 2026-10-15 · Status: Accepted, amended by [0069](0069-check-steps-run-the-repositorys-commands-in-an-attempt-of-their-own.md) (a check's command line starts through the platform shell) and [0076](0076-check-steps-run-in-an-os-sandbox-with-no-network.md)

## Context
The process runner (`src/platform/processes.ts`) starts every program without a shell, from the file `resolveExecutable` finds, so a repository cannot plant its own `git.exe` (#12). On Windows that cannot start a `.cmd` or `.bat` file: since Node's fix for CVE-2024-27980, `spawn` refuses them without a shell (`EINVAL`). Two tools Foedrum needs often are such files: `npm.cmd`, always, and `claude.cmd` when Claude Code was installed with npm. Architecture §13 already allowed one shell spawn, `claude` on Windows, with every part checked by `windowsCommandLine`; `foedrum doctor` (#13) is the first code that has to start one, and it must also start `npm.cmd`.

A shell brings two lookups the runner's own resolution does not cover:
- **cmd.exe itself.** With `shell: true`, Node runs `ComSpec`, or a bare `cmd.exe` when it is unset, which Windows looks for in the working directory first.
- **What the `.cmd` file runs.** npm's shims run a bare `node` when no `node.exe` sits next to them. cmd.exe looks for it in the working directory before PATH, so a `node.cmd` in a repository would run instead.

## Decision
- On Windows the runner starts every `.cmd` and `.bat` file through cmd.exe, and everything else without a shell (`spawnCommand`). Not only `claude`: any such file a caller resolved.
- The command line is built by `windowsCommandLine`: every part checked against a strict pattern and double-quoted. A part outside it is refused before anything starts, and the runner reports why.
- cmd.exe is named by its full path, `%SystemRoot%\System32\cmd.exe` (`C:\Windows` when `SystemRoot` is unset), never through `ComSpec` or a lookup, as taskkill already is.
- cmd.exe runs with `NoDefaultCurrentDirectoryInExePath` set, so the commands inside the file are never looked up in the working directory.

## Consequences
- doctor reads `npm.cmd`'s and `claude.cmd`'s versions; the brewer runner can start an npm-installed `claude` through the same runner.
- A `.cmd` path or argument with a character outside the pattern (`&`, `%`, `!`, `^`, `"`, line breaks) cannot be started, for example a profile folder named `R&D`. doctor shows the refusal; the user can install Claude Code with its native installer, which gives `claude.exe`.
- An integration test plants `node.cmd` and `node.bat` in the working directory and checks that the real `node` runs.

## Alternatives considered
- **Find the script behind each shim** (for npm, `node_modules/npm/bin/npm-cli.js` next to `npm.cmd`) and run it with `process.execPath`: no shell at all, but it depends on each tool's install layout and breaks when a shim changes.
- **Allow a shell for `claude` only:** keeps the exception narrow, but `npm.cmd` needs the same, and two code paths would differ only in a name check.
- **`shell: true` with `ComSpec`:** what Node offers, but it trusts the environment's choice of shell and a bare name lookup.
