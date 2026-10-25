# 0183. The engine's fixed rules for a brewer go in an appended system prompt

Date: 2026-10-25 · Status: Accepted · Amends [0041](0041-untrusted-input-in-per-prompt-nonce-tags.md) (what goes in the system prompt and what stays in the user prompt), [0042](0042-the-claude-command-line-and-stream-contract.md) (the runner passes `--append-system-prompt-file`), [0059](0059-attempt-plans-from-the-brewer-of-the-step.md) (an attempt's plan carries its system prompt), [0074](0074-git-commit-grants-fixed-git-rules-and-done-needs-a-commit.md) (the committing contract no longer ends with `Do not push.`), [0085](0085-the-out-doc-contract-names-the-attempts-shell-commands.md) (the attempt's shell commands move from the out doc contract to that file) [0087](0087-sandboxed-commands-go-through-the-allow-rules-and-never-see-credentials.md) (its "Your shell runs only" line is now in that file), [0126](0126-foedrum-resume-opens-a-finished-attempt-s-session-in-its-worktree.md) and [0127](0127-foedrum-resume-takes-a-running-batch-over-and-continues-its-step-s-session.md) (resume and the takeover also write the system prompt file and pass `--append-system-prompt-file`)

## Context
A brewer that commits gets `Bash(git status *)`, `Bash(git add *)` and `Bash(git commit *)` ([ADR 0074](0074-git-commit-grants-fixed-git-rules-and-done-needs-a-commit.md)).
The engine's rules for it, its shell commands (ADR 0085), to commit before the out doc and not to push, closed the out doc contract, which went with the brewer's instructions and its inputs as one user prompt on stdin (ADR 0041, ADR 0042).
`claudeArgs` already took `--append-system-prompt-file`, but no plan set it.

Brewers lost turns to denials on nearly every brew.
In the fifth brew's Gauger (batch `10-1`, session `75f34c96`) a `git add <file> && git commit -q -m "<subject>\n\n<body>" && git status --short && git log --oneline -1` was denied twice, and the commit that went through after it had lost its body (#485).
That issue guessed that the `&&` or the line break inside `-m` was refused.

### What is refused
A probe on claude 2.1.310 (Windows, subscription login) ran the brewer's command line (`claudeArgs`), a committing brewer's settings written by `attemptSettings`, and the brewer's environment (`brewerBaseEnv` and `brewerForcedEnv`), headless, and asked for one command per run:

| Command | Plain repository | Worktree of a bare clone |
|---|---|---|
| `git add f && git commit -m "s"` | allowed | allowed |
| `git commit -m "s` + line break + `body"` | allowed | allowed |
| `git commit -m "s" -m "body"` | allowed | allowed |
| `git commit -m "$(cat <<'EOF' … EOF)"` | allowed | allowed |
| `git log --oneline -1` | allowed | **denied** |
| the Gauger's command, word for word | allowed | **denied** |

- In a plain repository claude allows git's read-only commands without a rule. In a worktree of a bare clone, which is how every attempt runs ([ADR 0012](0012-worktrees-from-local-clones.md)), it does not, and `git log` is denied under `dontAsk`.
- One part that no rule allows denies the whole joined command, so the `git add` and `git commit` before it never run.
- Every denied `git add … && git commit …` in the transcripts of brews `7-1` to `10-1`, seven calls, ends in `&& git log --oneline -1`.
  The other denials there are `git diff`, `git show`, `git ls-files` and `git grep`, and edits through the shell: `cat >>` with a heredoc, `python3 - <<EOF`, `cp` and a redirect to `/tmp`.

Neither the `&&` nor a line break is refused, so a rule against them would tell the brewer something false.

### What the rule's wording and its place do
A seeded task (add `mul` and its test to a seeded repository, as two commits each with a subject and a body, and make sure both landed), sonnet at high effort, the brewer's environment, in a worktree of a bare clone, three runs per arm:

| Where the rules are | Denials per run | Turns | Commits with a body |
|---|---|---|---|
| Today: the out doc contract's "Your shell runs only: git status, git add, git commit." | 1, 1, 1 | 12, 10, 10 | 6 of 6 |
| The new wording below, in `--append-system-prompt-file` | 0, 0, 0 | 11, 11, 11 | 6 of 6 |
| Control: the same new wording in the user prompt | 0, 0, 0 | 11, 11, 11 | 6 of 6 |

Each of today's denials was a joined commit ending in `git log --stat`.
In both arms with the new wording every command ran in a call of its own, and every commit was `git commit -m "<subject>" -m "<body>"`.
At three runs per arm the wording fixed it in either place: the measurement does not show that the system prompt beats the user prompt.

## Decision
- **Each attempt gets an appended system prompt file** beside its settings file, `<workRoot>/attempt-settings/<batch>/<step>/<attempt>.system.md` (`systemPromptFileOf`), which the runner writes before claude starts and passes with `--append-system-prompt-file <file>`, for a new session and a resumed one alike.
  The plan carries its path and text (`ClaudeAttemptPlan.systemPrompt`); the text comes from `attemptSystemPrompt`, from the brewer and the attempt's allow rules alone, the same on every platform.
- **The file holds the engine's fixed rules**, which no input, instruction or repository can change, under the heading `# Rules of this session` and a line that says they come from the engine:
  - with shell rules that do not allow any program: `Your shell runs only these commands: <commands>. Every other command is refused, read-only ones too, such as git log, git diff and git show.`, naming only the examples the allow rules do not cover;
  - with them: `A command joined to a refused one with `&&`, `;` or `|` is refused whole, so run a command that may be refused on its own`, and for a brewer that commits `, never joined to git add or git commit`;
  - with a shell and Edit or Write: to write and change files with those tools, never through the shell (no `cat >`, `echo >`, heredocs, `sed -i` or scripts);
  - for a brewer that commits: `git commit -m "<subject>" -m "<body>"`, one `-m` per paragraph;
  - always: `Do not push.`;
  - with shell commands: `A denial stops that command only, never the whole shell.` (ADR 0085's line, moved).
- **The user prompt keeps the rest, as ADR 0041 built it:** the brewer's instructions, the out doc contract (its examples, the asking paragraph, and for a brewer that commits to commit before it writes the out doc and to leave the out doc out of every commit), then the rule and the inputs in nonce tags, unchanged.
  The out doc contract no longer names the shell commands or says not to push: those are in the file.
- **The system prompt is the place, though the control arm did as well.** It keeps the engine's rules apart from the prompt the inputs travel in, where an input could imitate them, and the earlier experience with `claude -p` agents (#485) is that a rule in the system prompt is followed more reliably over a long run than the same rule in the task's prose; the seeded task above is short.
- **A resumed session gets the file too.** Claude Code records a conversation's system prompt on its first request and reuses that record on every later request, a `--resume` included, until the conversation is compacted ([CLI reference](https://code.claude.com/docs/en/cli-reference), "System prompt flags in resumed conversations", read 2026-10-25; `--system-prompt-snapshot`, on by default).
  A probe resumed one of the measured sessions without the file and it quoted the rules word for word, so a resumed attempt has them either way; the file is still passed, for the requests after a compaction, which render the prompt again from the flags of that launch.
- **The interactive takeover and `foedrum resume` pass it as well** ([ADR 0126](0126-foedrum-resume-opens-a-finished-attempt-s-session-in-its-worktree.md), [ADR 0127](0127-foedrum-resume-takes-a-running-batch-over-and-continues-its-step-s-session.md)): the CLI reference says all the system prompt flags work in interactive and non-interactive mode, and both write the file beside the settings file they write.
- **The sandboxed level does not change this.** ADR 0087 sets `autoAllowBashIfSandboxed: false`, so allow rules decide there too, and git's read-only commands are refused there as here. It was not measured on Linux or macOS.

## Consequences
- A brewer that commits is told which command forms are refused before it tries one, so the measured denials of a joined commit stop, and its commits keep their bodies.
- The settings cleanup removes whole batch folders under `attempt-settings` ([ADR 0063](0063-foedrum-serve-its-configuration-and-wiring.md)), so the system prompt files go with them.
- The out doc contract is shorter; the system prompt file adds about 150 tokens to an attempt that commits, about 15 to a read-only one, and is the same for every attempt of a brewer, so it is cached with Claude Code's own system prompt.
- git's read-only commands (`git log`, `git diff`, `git show`, `git ls-files`, `git grep`) stay refused in an attempt's worktree by design: `git.commit` grants only fixed subcommands that never reach outside the worktree (ADR 0074), and a brewer that needs another one names it in its own `tools.allow`. The rules now say so, so a brewer no longer finds out by trial.
- No line-break rule: if a later claude refuses a line break inside a command, the wording has to change with it.

## Alternatives considered
- **Reword the contract's shell line only.** The control arm shows it cuts the denials as well at this sample size. It leaves the engine's rules in the prompt the inputs travel in, and does not use what claude offers for exactly this.
- **Rules against `&&`, `;`, `|` and line breaks.** What the issue proposed; the probe shows none of them is refused, and a false rule costs the brewer turns of its own.
- **Allow `git log`, `git diff` and `git show` to a brewer that commits.** It would end these denials at the source, but `git diff --no-index` and `git log --output` reach any file, which is why ADR 0074 refuses them to a brewer that commits; a brewer that needs one names it in its own `tools.allow`.
- **Replace the whole system prompt (`--system-prompt-file`).** It drops Claude Code's own tool guidance, which the brewers rely on.
