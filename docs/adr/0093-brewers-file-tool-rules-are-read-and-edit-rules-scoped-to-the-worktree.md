# 0093. A brewer's file-tool rules are Read and Edit rules scoped to its worktree

Date: 2026-10-20 · Status: Accepted · Amends [0049](0049-reviewers-read-only-inside-the-checkout.md)

## Context
Under `dontAsk` (ADR 0042) a bare file-tool allow rule allows its tool anywhere on disk: a brewer allowed `Write` writes `~/.bashrc` as readily as a file in its worktree. The read guard of ADR 0049 cannot cover brewers, because the runner's `--safe-mode` turns off the hooks of the `--settings` file as well. ADR 0049 therefore decided that `attemptSettings` turns the brewer's bare `Read`, `Edit` and `Write` into `Read(./**)`, `Edit(./**)` and `Write(./**)`, and a bare `Grep` or `Glob` into `Read(./**)` (#135).

Claude Code's permissions page ([code.claude.com/docs/en/permissions](https://code.claude.com/docs/en/permissions), "Read and Edit" and "Symlinks", read 2026-10-20) says that `Write(./**)` would be a rule it never reads:

> Claude Code checks file permissions against `Edit(path)` and `Read(path)` rules only. If you write a path rule for `Write`, `NotebookEdit`, `Glob`, or the legacy `MultiEdit` tool instead, Claude Code accepts the rule but never consults it, and warns at startup, except for a `Glob` rule passed in `--allowedTools`. Use `Edit(docs/**)` in place of `Write(docs/**)`, `NotebookEdit(docs/**)`, or `MultiEdit(docs/**)`, and `Read(docs/**)` in place of `Glob(docs/**)`. Claude Code doesn't warn about a tool-name rule with no path, such as a deny rule for `Write`; it matches that rule at the tool level everywhere.

> `Edit` rules apply to all built-in tools that edit files. Claude makes a best-effort attempt to apply `Read` rules to all built-in tools that read files like Grep and Glob, […]

The same page gives the anchor of a relative pattern, "`path` or `./path` | Path relative to current directory", which for a brewer is its worktree, and for links:

> **Allow rules**: apply only when both the requested path and the file it resolves to match. A read through a symlink inside an allowed directory that points outside it doesn't match the rule.

and says this "applies to symbolic links on macOS, Linux, and Windows, and to directory junctions on Windows".

## Decision
- **`attemptSettings` scopes each bare file-tool allow rule to the worktree.** A bare `Read`, `Grep` or `Glob` becomes `Read(./**)`; a bare `Edit`, `Write`, `MultiEdit` or `NotebookEdit` becomes `Edit(./**)`, never `Write(./**)`. Each scoped rule is written once, where the first rule that became it stood; every other rule keeps its place. `--tools` still comes from the brewer's own rules (`toolsOf`), so a brewer allowed `Write` still has the Write tool, and `Edit(./**)` is the rule that decides where it writes. This replaces the sentence of ADR 0049 that names `Write(./**)`.
- **The `AttemptSettings` schema refuses what claude would not read as it seems to.** In `allow`, a bare file-tool rule (`Read`, `Grep`, `Glob`, `Edit`, `Write`, `MultiEdit`, `NotebookEdit`), with a message that names `Read(./**)` or `Edit(./**)`. In `allow` and in `deny`, a path rule for `Write`, `MultiEdit`, `NotebookEdit` or `Glob`, with a message that names the `Edit(…)` or `Read(…)` of the same path. A bare file tool in `deny` stays: Claude Code matches it at the tool level, so it removes the tool everywhere.
- **A brewer file refuses such a path rule when it loads.** `BrewerAllowedTool` and `BrewerDeniedTool` (`src/schemas/primitives.ts`) refuse a `Write`, `MultiEdit`, `NotebookEdit` or `Glob` path rule in a brewer's `tools`, with the same message, so `foedrum doctor` reports it with the file, as ADR 0062 and ADR 0082 refuse rules. A bare file tool stays valid there: it is what `attemptSettings` scopes. A repository's toolchain rules in `foedrum.jsonc` are not brewer rules; one with such a path rule is refused when an attempt is planned, like a toolchain rule that reaches git (ADR 0062): the attempt fails, not retryably, as `the brewer could not start`, with the message.
- **Path rules the brewer writes for `Read` and `Edit` pass through as they are.** A rule anchored at `/`, `//` or `~`, or with a `..` segment, still needs the same rule in the permission ceiling (ADR 0026).
- **A test against the installed `claude`, opt-in (ADR 0057).** `test/integration/file-rules.test.ts` writes the settings `attemptSettings` makes for a brewer allowed bare `Read`, `Edit` and `Write`, runs the runner's command line with `--safe-mode` and the fake Messages API, and checks that `Write` and `Edit` inside the worktree run, that both are denied outside, through `..`, and through a junction (a directory link on macOS and Linux) that leads outside, with nothing written there, and that `Read` is denied outside and through a junction. Like the runner settings tests, it tests Foedrum's settings file against whatever `claude` is installed, not `claude` itself.

## Consequences
- A brewer's file tools reach only its worktree on every isolation level, native Windows included, where shell commands are still unsandboxed (architecture §13). A shell command the brewer may run (`npm test`) still reads and writes what the OS lets it: the rules govern the file tools only.
- A brewer file with a path rule such as `Write(brew.md)` no longer loads; the message names `Edit(brew.md)`. That rule never allowed anything, so the brewer could not write that file before either. `Edit(brew.md)` alone gives the brewer the Edit tool, which creates a file when its `old_string` is empty (the test above does).
- Against `claude` 2.1.301 on Windows, before this change, a write through a junction that leads outside was already denied with bare rules, while a write outside or through `..` was not. The junction case went in as a regression test.
- `Read(./**)` covers `Grep` and `Glob` on a best-effort basis, as the docs say. ADR 0049's verification of `Grep` and `Glob` with `Read(./**)` against `claude` 2.1.301 stands; its tests left the suite with ADR 0057.
- ADR 0079's push scan names a brewer whose file rules are not yet scoped (#135) as one that can commit a file read outside its worktree. After this change that is left to what a shell command reads, on native Windows or outside the sandbox's limits.

## Alternatives considered
- **`Write(./**)` as ADR 0049 said:** Claude Code never consults it, so a brewer allowed `Write` and given `Write(./**)` could write nowhere under `dontAsk`, or, next to a bare `Write`, anywhere.
- **Refuse such a path rule only in the attempt settings:** a brewer file would load and pass `foedrum doctor`, and every attempt of its steps would then fail; a configuration error should show when the file is read (ADR 0026).
- **Turn a path rule such as `Write(brew.md)` into `Edit(brew.md)` instead of refusing it:** it would quietly change what a brewer file says. A refusal that names the rule to write keeps the brewer file the source of what the brewer may do.
- **Leave bare rules in place and rely on the `scope` guard after the attempt:** the guard sees changed files in the worktree, not a file written or read elsewhere.
