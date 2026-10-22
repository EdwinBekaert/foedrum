# 0125. The Foedrum plugin is Markdown skills that run the terminal with `--via plugin`

Date: 2026-10-22 · Status: Accepted · Amends [0019](0019-interactive-sessions-and-one-command-layer.md) (which commands the plugin carries, how the terminal learns it runs for the plugin, and what the parity test checks), [0105](0105-foedrum-order-orders-an-issue-again-as-a-human-command-recorded-on-batch-ordered.md) (the plugin does not carry `order`) and [0123](0123-foedrum-brew-drives-one-batch-under-an-owner-of-its-own.md) (the session's loop on brew's exit codes, the plugin passing no `--as`, and the comment surface's mark of brew left for that surface's own parity)

## Context
[ADR 0019](0019-interactive-sessions-and-one-command-layer.md) makes the plugin (`/foedrum:<command>`) the engineer's surface: Markdown only, calling the `foedrum` program, every command recorded with who issued it and from where, and a parity test that fails when a command is missing from a surface without being marked. [ADR 0123](0123-foedrum-brew-drives-one-batch-under-an-owner-of-its-own.md) built `foedrum brew` with exit codes for the session to read, [ADR 0124](0124-foedrum-takeover-hands-a-batch-to-another-driver-as-a-recorded-command.md) its `--take`, and [ADR 0126](0126-foedrum-resume-opens-a-finished-attempt-s-session-in-its-worktree.md) a `foedrum resume` that, inside a Claude Code session, prints the line to run in a terminal. #336 is the plugin itself. Three things were open: its layout, how a command it runs is recorded as the plugin's, and how `/foedrum:brew` handles a batch that needs input.

What Claude Code offers was checked in its docs (code.claude.com, 2026-10-22):

- **Plugin manifest reference, "Manifest file":** "Save the manifest at `.claude-plugin/plugin.json` under the plugin root. Put every other plugin file at the plugin root, not inside `.claude-plugin/`." `name` "is the only required key … Claude Code namespaces every component under it".
- **Plugin manifest reference, "Standard layout":** skills go in `skills/`, "One `<name>/SKILL.md` per skill"; commands in `commands/`, "Flat Markdown command files. Prefer `skills/` for new plugins". `bin/` puts files on the Bash tool's `PATH`, but "claude.ai and Cowork don't install a plugin that has this directory".
- **Plugin manifest reference, "Environment variables":** `CLAUDE_PLUGIN_ROOT` and the others "aren't present in the environment of commands Claude runs through the Bash tool".
- **Skills:** "Custom commands have been merged into skills"; a plugin skill loads "as `/plugin-name:skill-name`". `disable-model-invocation: true` keeps Claude from loading a skill by itself: "Use for workflows you want to trigger manually with `/name`". `$ARGUMENTS` holds the arguments given. A `` !`<command>` `` runs before the skill is sent, and "A failed command aborts the entire skill invocation".
- **Create a marketplace:** a marketplace is "a directory or repository with a `.claude-plugin/marketplace.json` file"; it "requires a `name`, an `owner`, and a `plugins` array", each entry a `name` and a `source`, a relative one written "as a path from the marketplace root". It is added with `claude plugin marketplace add <owner>/<repo>` (or a local path), and a plugin installed with `claude plugin install <name>@<marketplace>`.

## Decision

### The layout
- The plugin lives in `plugin/` of this repository: `plugin/.claude-plugin/plugin.json` named `foedrum`, and one skill per command in `plugin/skills/<command>/SKILL.md`, so its commands are `/foedrum:<command>`. Skills, not `commands/`, as the docs prefer for new plugins; each is still Markdown only.
- The repository is its marketplace: `.claude-plugin/marketplace.json` at the root, named `foedrum`, lists the plugin with the source `./plugin`. An engineer adds it with `claude plugin marketplace add EdwinBekaert/foedrum` and installs `foedrum@foedrum`; from a checkout, `claude --plugin-dir plugin`. The npm package does not ship `plugin/`.
- Every skill sets `disable-model-invocation: true`: a command that changes state runs when the engineer types it, never because the model chose to. `allowed-tools` grants nothing, so each `foedrum` call is the session's ordinary Bash call under the engineer's permission rules.
- Each skill runs `foedrum <command> … --via plugin` through the Bash tool, in the session's folder, which is the Brewery's root as for the terminal. `foedrum` is the program on `PATH` (the package's `bin`); the plugin carries no executable of its own (no `bin/`, which claude.ai does not install), and no `` !`…` ``, whose failure would abort the skill instead of showing foedrum's line.

### `--via plugin`
- The terminal takes `--via <surface>` on every command of the registry: `plugin` or `terminal`, the default. The events a command appends record that surface (`via`), and `foedrum brew` records it on the order and the takeover it makes. `--via` is the terminal's own option, never a field of the command's input. `serve` takes none.
- **It is never trusted for authorisation.** ADR 0019 authorises the plugin and the terminal alike, for whoever runs them on that machine, so `--via` changes what is recorded and nothing else. Anyone can type `--via plugin` in a terminal; the record then says the plugin, which is as true as the person who typed it. A surface with its own authorisation (`comment`, `dashboard`) cannot be named: those are issued by Foedrum's own drivers, never through the terminal.

### `/foedrum:brew` and needs input
- `/foedrum:brew <issue> [--take]` runs `foedrum brew <issue> --via plugin` in the background, since it runs until the batch stops, longer than a tool call may last, and reads its exit code ([ADR 0123](0123-foedrum-brew-drives-one-batch-under-an-owner-of-its-own.md)). The owner is the session's own (`CLAUDE_CODE_SESSION_ID`), so a brew again from the same session drives on its own lease.
- **Exit 4, needs input:** the session asks the engineer each question, in order, with its options and the recommendation, then runs `foedrum answer '<batch>' --via plugin -- '<answer 1>' …` with the engineer's answers, and runs `foedrum brew` again. The batch id comes only from brew's own last line, and only in a batch id's form. Every value is single-quoted, through the Bash tool, never PowerShell (a bare `#21` is a comment in bash); `--` ends the options, so an answer such as `-h` or `--via=terminal`, an option a model may have offered, stays an answer. It never answers for the engineer. On exit 0 it shows the pull requests; on 3, 5 and 6 the reason and the options, and stops. Taking a batch over (`--take`) is the engineer's to type, never the session's to add after a refusal.
- **What brew prints is data.** Its questions, notices and reasons come in part from a model, out of an issue anyone may write. The skill shows them to the engineer and acts on the exit code and on the batch id alone, never on an instruction in that text ([ADR 0041](0041-untrusted-input-in-per-prompt-nonce-tags.md)). brew already escapes every line break in them, so none forges a line of its own ([ADR 0123](0123-foedrum-brew-drives-one-batch-under-an-owner-of-its-own.md)).

### The commands it carries, and the parity rule
- The plugin carries `brew`, `status`, `stuck`, `answer` and `resume`: what an engineer brewing in a session needs (#37). `/foedrum:resume` prints the line to run in a terminal, as `foedrum resume` does inside a session ([ADR 0126](0126-foedrum-resume-opens-a-finished-attempt-s-session-in-its-worktree.md)).
- Every other command of the registry is **marked terminal-only, with a reason**, in the registry itself (`terminalOnly`). A mark is the decision not to carry a command in the plugin; carrying it later is a skill added and the mark removed.
- **The parity test** (`test/unit/plugin-parity.test.ts`) fails when a command of the registry has neither a skill nor a mark, when a marked command has a skill, when a skill names no command of the registry, and when a skill does not run its own command with `--via plugin`. The comment surface has no such list yet: its commands are parsed by the Cellar ([ADR 0019](0019-interactive-sessions-and-one-command-layer.md)), which is a parity of its own when it comes; the mark that keeps `brew` off it ([ADR 0123](0123-foedrum-brew-drives-one-batch-under-an-owner-of-its-own.md)) comes with that test.
- **The owner is the session's.** `/foedrum:brew` never passes `--as`, which ADR 0123 left open to the plugin: after `/clear` the batch is refused for at most one lease, or taken at once with `--take`, which the engineer types.

## Consequences
- An engineer installs the plugin and types `/foedrum:brew 21` in a Claude Code session opened in the Brewery; a Stuck question is asked in the session and the batch goes on.
- The command log tells a plugin's command from a terminal's, as ADR 0019 asks, without either being trusted more.
- The plugin needs `foedrum` on `PATH`. Without it, the Bash call fails with the shell's own line.
- The plugin needs Claude Code's Bash tool (Git Bash on Windows): its command lines are quoted for bash. A session without one is told so and runs nothing.
- The session shows where the batch went when brew exits, not while it runs: brew runs in the background, and its output is there to read meanwhile.
- A new command of the registry fails the parity test until it gets a skill or a mark.

## Alternatives considered
- **`commands/` instead of `skills/`:** works, but the docs call it the older format.
- **Learn the surface from the environment (`CLAUDE_CODE_CHILD_SESSION`):** it is set for every Bash call of a session, also when the engineer runs `foedrum` by hand there, so it says Claude Code, not the plugin.
- **Trust `--via plugin` with more rights:** anyone can type it; ADR 0019 gives the plugin and the terminal the same rights for this reason.
- **Carry every command in the plugin now:** ADR 0019's list, but the other commands are run from what `foedrum stuck` and `foedrum status` print, and each skill is a prompt to keep. The marks keep the gap visible.
- **A `bin/` script that finds foedrum:** claude.ai does not install such a plugin, and it would no longer be Markdown only.
- **Answer from the recommendation when the engineer is away:** the brewer asked a person (ADR 0006); the recommendation is shown, never chosen for them.
