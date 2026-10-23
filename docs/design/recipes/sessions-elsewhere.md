# A brewer's session on another machine

[ADR 0019](../../adr/0019-interactive-sessions-and-one-command-layer.md) lets anyone step into any brewer's session.
On the machine where the attempt ran, that is `foedrum resume` ([ADR 0126](../../adr/0126-foedrum-resume-opens-a-finished-attempt-s-session-in-its-worktree.md)).
This page holds the result of the spike of #38, which checked whether a session can be carried to another machine and resumed there.
It was a spike: nothing in Foedrum changed, and no decision was recorded.

## The result

- Claude Code can resume a transcript carried to another checkout: `claude --resume <absolute path of the .jsonl>` continues the conversation there, with the model, tools and settings of the new command line.
- Foedrum does not carry transcripts, on the state branch or anywhere else: a transcript holds the target repository's files, the order's text, the maintainer's account email and home path, and about half a megabyte per attempt, in a format Claude Code says is internal.
- On another machine, an attempt is **inspect only** through what the state branch already holds: its events, its out doc and its commits.
- To go on from there, a human starts a fresh attempt with the same in-docs (`foedrum retry`, `foedrum rewind`), which is ADR 0019's fallback and what a resume that finds no session does already ([ADR 0117](../../adr/0117-a-retry-resumes-the-session-of-the-attempt-before-it-in-that-attempt-s-worktree.md)).

## Where Claude Code keeps a session

From Claude Code's docs (code.claude.com, "Manage sessions", "CLI reference" and "Model configuration", read 2026-10-23), as ADR 0116 found:

- A transcript is `~/.claude/projects/<project>/<session-id>.jsonl`, where `<project>` is the working directory with every non-alphanumeric character replaced by `-` (cut at 200 characters, with a hash of the path).
- `CLAUDE_CONFIG_DIR` moves the store, and `CLAUDE_CODE_PROJECT_DIR_NAME`, with it, names the project folder.
- `--resume <id>` looks in the current project and its git worktrees, then in every other project on the machine, and resolves an id there only when exactly one project holds it; otherwise it says `No conversation found with session ID: <id>`.
- `--resume` also takes the absolute path of a `.jsonl` transcript.
- There is no import: the docs name no way to bring a session in, and `--teleport` is for cloud sessions only.
- "The entry format is internal to Claude Code and changes between versions"; the docs point scripts at `/export`, `claude -p --resume` and hooks' `transcript_path` instead.

## What was tried

Claude Code 2.1.301 on Windows, `claude -p` with a brewer's flags (`--setting-sources ""`, `--safe-mode`, `--tools`, `--model haiku`), in two scratch repositories under `.foedrum/tmp/38/`: `a`, and `b`, a clone of `a` at the same commit.

- A sibling git worktree cannot stand in for another machine: `--resume <id>` finds the transcript in the other worktree's project folder where it is.
  So `b` is a clone, the transcript was moved out of Claude Code's store, and `a` was renamed away, so its paths no longer exist.
- The first run in `a` read a committed file and wrote an uncommitted one, `made.txt`, with `--session-id <id>`.
- `claude -p --resume <id>` in `b`: `No conversation found with session ID: <id>`, exit code 1.
- `claude -p --resume <carried path>\<id>.jsonl` in `b`: the session resumed with its id, in `b` (claude's init reports `b` as its working directory), and remembered what it had read.
  Asked for `made.txt`, it found none in `b`, since the file was never committed, then reached for its path in `a`, outside the working directory, which was not allowed.
- The resumed turns were written beside the carried file, as `<folder>/<id>.jsonl`, not in the store: a transcript given by a path of another name gets a new file of the id's name in that folder.
  With `--fork-session` the new session went to `b`'s project folder in the store instead.
- The transcript copied into `b`'s project folder in the store resumed by its id alone, from `b`.

So a worktree at the same commit is not the worktree the session left: its uncommitted changes stay on the first machine, and its history names the first machine's paths.

## Version drift

- The docs name no rule for a transcript written by another version.
- A transcript whose `version` fields were changed to `2.0.0` and to `9.9.999` resumed under 2.1.301 without a word.
  Only one version is installed here, so a real older or newer binary was not tried; the label is not checked, but a change in the format would be met only when it happens.
- **Model:** a resumed session keeps the model its transcript names, unless `--model` or `ANTHROPIC_MODEL` is given, or the model was retired, or the provider uses its own deployment ids (docs).
  Resumed with `--model sonnet`, a Haiku session continued on Sonnet, its history intact.
- **Tools and settings:** `--settings`, `--mcp-config` and the other launch flags are not restored and must be passed again; the standard settings files are read again at launch (docs).
  Resumed with `--tools Read`, claude's init listed only `Read`, and a write was refused as `No such tool available`.
  Foedrum already passes the brewer's flags on every resume (ADR 0117's plan, ADR 0126's command line), so a resumed attempt runs under today's brewer, as ADR 0126 notes.
- **System prompt:** the system prompt recorded on a session's first request is reused until the session is compacted, so system prompt flags given on resume take effect only after a compaction (docs).

## Size and privacy

Measured on the 7 transcripts of the 6 attempt folders of today's brews in `~/.claude/projects` (2026-10-23); counts and kinds only:

- **Size:** 159 KB to 1.08 MB per transcript, 3.48 MB in all, 0.74 MB gzipped; one gauge attempt alone was 1.08 MB.
- **What fills it:** tool results (1.17 MB of the 3.48), copies of the requests sent to the API (0.80 MB), the model's turns (0.79 MB) and context attachments (0.33 MB).
- **File contents:** every `Read` result holds the file it read (1 to 19 per transcript), and every `Edit` result holds the whole file before the edit (`originalFile`) and its patch.
- **Paths:** the absolute working directory is on every entry (`cwd`) and in every tool input, so the maintainer's home folder appears 60 to 400 times per transcript.
- **The account:** the signed-in account's email and the git status context (branch, git user) are in each session's context attachment, also under `--setting-sources ""` and `--safe-mode`.
- **The order:** the prompt holds the brewer's inputs, the order's issue text among them, which is untrusted (ADR 0041).
- **Secrets:** a search for GitHub tokens and Anthropic keys found none; that is no proof, since `Bash` output is kept as it was printed.

### What would have to be redacted

The account email and the git context, every absolute path, every file's contents in `Read` and `Edit` results, `Bash` output, and the order's text.
Paths and file contents are what the session is: a transcript without them resumes as a conversation about nothing.
A redactor would also parse a format Claude Code changes between releases, which ADR 0116 and ADR 0126 chose not to depend on.

### Why not the Brewery repository

- The state branch is pushed git history: what goes on it cannot be taken back, and the 30-day retention would no longer hold.
- Everyone who can read the Brewery repository could read the target repositories' files, which need not be the same people.
- At about half a megabyte per attempt, every clone of the Brewery would carry every attempt's transcript forever.

## If carrying is wanted later

A resume by path works, so carrying needs only a store for the file, outside the state branch, private, with a retention, and placed as `<id>.jsonl` because claude writes on beside it.
That store, and who may read it, would be a decision of its own, with its row in [trust boundaries](../../trust-boundaries.md).
