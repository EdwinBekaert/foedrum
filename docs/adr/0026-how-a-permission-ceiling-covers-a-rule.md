# 0026. How a permission ceiling covers a rule

Date: 2026-10-15 · Status: Accepted

## Context
A Brewery sets a **permission ceiling**: the most that the rules it does not write itself may grant. Today that is the toolchain rules each repository adds to its brewers' allowlists in `foedrum.jsonc` ([ADR 0023](0023-language-independent-recipes.md)); later it is also what an installed pack may ask for (architecture §12). Foedrum has to decide, without running anything, whether a rule such as `Bash(dotnet test*)` stays within a ceiling rule such as `Bash(dotnet *)`.

Comparing the two as plain text globs is not enough, because Claude Code does not read a specifier as plain text. It splits a shell command on operators, so `Bash(npm *)` does not allow `npm test && curl … | sh`, but a glob in which `*` matches any text says the ceiling covers it. PowerShell evaluates a parenthesised argument or a script block as a command. Path rules are gitignore-style: `*` stays within one folder and `**` crosses folders, a `..` segment leaves the folder the rule names, and `//path`, `/path` and `~/path` are anchored outside the worktree. In each case a rule that looks narrower than the ceiling grants more. The review of #52 found these bypasses one after another.

## Decision
- **Fail closed.** A rule is within the ceiling only when a ceiling rule for the same tool covers it. Anything the comparison cannot be sure of is outside the ceiling. Without a ceiling, nothing is added.
- A ceiling rule **covers** a rule for the same tool when the ceiling rule has no specifier (a bare tool), when the specifiers are identical, or when the ceiling's specifier, read as a glob, matches the rule's specifier as written, within these limits:
  - In `Bash` and `PowerShell` rules, a `*` never stands for `;`, `&`, `|`, a backtick, `$`, `<`, `>`, `(`, `)`, `{` or `}`.
  - In path rules (`Read`, `Edit`, `Write`, `MultiEdit`, `NotebookEdit`), a `*` stays within one folder: it never stands for `/`, `\` or `*`. A `**` crosses folders.
  - In other rules, a `*` stands for any text.
  - A rule with a `..` segment, or a path rule anchored at `/` or `~`, is only covered by an identical specifier or a bare tool.
- A `*` in the rule itself is literal text that only a ceiling `*` can stand for. The matcher is linear and uses no regular expression built from the rules.
- `AskUserQuestion` is never allowed, whatever the ceiling says ([ADR 0006](0006-no-mid-run-questions.md)).
- The rule is implemented once, in `withinCeiling` (`src/schemas/primitives.ts`). Repository toolchain rules use it now, and pack ceilings will use the same function.

## Consequences
- A configuration error (a rule outside the ceiling) shows up when `foedrum.jsonc` is read, with the path of the rule, not when a brewer runs.
- Some narrower rules are refused, such as `Write(docs/a*)` under `Write(docs/*)`, or a command with parentheses under `Bash(npm *)`. Such a rule needs an identical ceiling rule. That is the cost of failing closed.
- The ceiling check does not replace Claude Code's own permission matching or the sandbox ([ADR 0010](0010-cross-platform-and-isolation-levels.md)); it keeps the Brewery's configuration from granting more than the ceiling states.
- When Claude Code adds a tool with path or command specifiers, the tool lists in `withinCeiling` have to follow; until then its `*` stands for any text.

## Alternatives considered
- **Plain text globs:** simple, but every bypass above passes.
- **Identical rules only:** safest, but every repository would need its exact rules in the ceiling, which defeats a ceiling such as `Bash(dotnet *)`.
- **Parsing shell commands and paths as Claude Code does:** precise, but it duplicates the matching of another tool, and it would drift whenever that tool changes. Failing closed on the characters and anchors that change meaning needs no parser.
