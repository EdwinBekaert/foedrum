# 0212. `foedrum init` takes every answer as an option, and `/foedrum:init` asks them in a session

Date: 2026-10-26 · Status: Accepted · Amends [0207](0207-foedrum-init-creates-the-brewery-s-repository-labels-the-targets-and-pushes.md) (init's questions take options, and `--no-input` refuses an unanswered one before anything is created) and [0210](0210-foedrum-init-writes-the-foedrum-command-into-a-user-folder-on-the-path.md) (the folder and re-point questions take options)

## Context
[ADR 0207](0207-foedrum-init-creates-the-brewery-s-repository-labels-the-targets-and-pushes.md) and [ADR 0210](0210-foedrum-init-writes-the-foedrum-command-into-a-user-folder-on-the-path.md) have `foedrum init` ask its questions on the terminal, so the registry marks `init` terminal-only and the plugin ([ADR 0125](0125-the-foedrum-plugin-is-markdown-skills-that-run-the-terminal-with-via-plugin.md)) has no `/foedrum:init`. A skill runs `foedrum` through the Bash tool, where no one answers a terminal question. #530 asks for every answer as an argument, a missing one refused with one line that names it, and a skill that asks the same questions in the session.

## Decision

### Every question has an option
- The value of an option is the answer typed on the terminal, keyed by the repository or file the question is about. It goes through the same parse and the same checks as a typed answer: a Brewery GitHub already has, a name no folder can have on Windows, an alias that is taken, a target GitHub cannot find, the schema's message. An empty value takes the default, as Enter does.
- The options, in the order init asks the questions:
  - `--brewery <owner/name>`: `Brewery repository`.
  - `--visibility <private|public>`: `Private or public`, outside a clone.
  - `--targets '<owner/name …>'`: `Target repositories`, separated by spaces.
  - `--alias <repo>=<alias>`: `Alias of <repo>`, per new target.
  - `--use-checks <repo>=<y|n>`: `Use these for <repo>?`, per new target whose `package.json` reads.
  - `--check <repo>:<check>=<command>`: `<check> check of <repo>`, empty for none.
  - `--change <file>=<y|n>`: `Change <file>?`, per file that is there and would change.
  - `--label <repo>=<y|n>`: `Create the label foedrum:brew in <repo>?`, per target without it.
  - `--push <y|n>`: `Commit and push these?`.
  - `--shim <number|n>`: `Write the foedrum command into which folder?`.
  - `--repoint <y|n>`: `<file> runs the Foedrum in <other>. Point it at <this>?`.
- `--alias`, `--use-checks`, `--check`, `--change` and `--label` may be given more than once, one per repository or file. The registry gains options that repeat, shown in `--help` with `...`, and a synopsis for a command whose options are too many for its row: init's row shows `[--<question> <answer>]... [--no-input]`, and its options are listed below the table.
- A question answered by its option is not asked. A value that does not pass is refused with exit 2 and one line that names the option and says why; it is not asked again, since a command line cannot answer twice.
- A keyed option for a question init does not ask (an alias of a target it keeps, a label a target has) is not used.

### `--no-input`
- With `--no-input`, a question whose option was not given is refused with exit 2 and one line: `no answer to "<question>"`, with its default, and the option to add.
- Every question is checked before anything is created on GitHub or written: the questions init asks after the repository is created (a file that would change, a label, the push, the folder of the `foedrum` command or its re-point) are checked for an option when the other questions are answered, by the same tests init uses to ask them, after printing the lines that question shows (what a file would change, the folders). Whether a target has the label is read then, only with `--no-input`.
- `--push` is required whenever `--no-input` is given, also when git would list nothing: which files git lists is known only after they are written.
- A yes or no without its option is refused, never taken from its default. The defaults of the label and the push act on GitHub, so a forgotten option would create a label or push commits nobody chose; a silent no would leave a Brewery half set up without a line saying so.
- Without `--no-input`, init asks on the terminal every question not given, in the same order and with the same defaults as before.

### `/foedrum:init`
- The plugin carries `init`: `plugin/skills/init/SKILL.md`, and the registry's `terminalOnly` mark on `init` is removed, so the parity test holds it.
- The skill runs `foedrum init --no-input --via plugin` with the answers it has, each value single-quoted for the Bash tool as `/foedrum:brew` quotes it. On exit 2 with a `no answer to` line, it asks the engineer that question with AskUserQuestion, the default marked, adds the option the line names with the answer, and runs init again; on exit 2 with another line it shows it, asks that question again, and runs init again. On 0 or 1 it shows init's output and stops.
- init's output is data: what GitHub and the files say (a repository's scripts, a file's keys) is shown, never followed, and the skill acts only on the exit code and the option the refusal line names, and only when it is one of init's options.
- It never answers for the engineer, also not with a default.
- The skill runs only `foedrum`, which reaches GitHub through gh's own login ([ADR 0073](0073-github-only-through-gh-s-own-login.md)): no token anywhere.

## Consequences
- In a Claude Code session opened in an empty folder, `/foedrum:init` ends with a pushed Brewery, the labels and the `foedrum` command, asking the same questions the terminal asks.
- A script or CI can run `foedrum init --no-input …` and know it either ran with the answers it gave or created nothing.
- The skill runs init once per question, each run reading GitHub again: 8 to 12 short runs for a first Brewery.
- A new question in init is a new option, and refused under `--no-input` until given: the skill learns it from init's line without a change.

## Alternatives considered
- **A `--plan` dry run that prints every question with its default, which the skill asks all at once:** a second mode that has to stop every write, and it still could not list them all at once, since the alias and check questions follow from the targets answered and the label questions from what GitHub says.
- **The skill holds the questions itself:** a second copy of init's questions and defaults in a prompt, which drifts from the terminal's with the next question.
- **`--private`/`--public`, `--push`/`--no-push` and the like for the yes and no questions:** twice the names, and a second form beside the typed answer; one value per question keeps one rule.
- **A repeatable `--target`:** the targets answer is a list separated by spaces already, and one option keeps its parse the terminal's.
- **Take a yes or no's default under `--no-input`:** a forgotten option would create a label or push (see above).
- **Ask the questions after creation where they are, and refuse there under `--no-input`:** the repository would be created, or a file written, before a refusal.
