# 0049. Reviewers read only inside the checkout: a read guard for the read-only agents, scoped rules for brewers

Date: 2026-10-16 · Status: Accepted · Amends [0010](0010-cross-platform-and-isolation-levels.md) and [0046](0046-only-the-runners-settings-the-init-check-and-a-line-by-line-stream.md) · Amended by [0057](0057-real-claude-tests-are-opt-in-and-claude-proofs-leave-the-suite.md) and [0093](0093-brewers-file-tool-rules-are-read-and-edit-rules-scoped-to-the-worktree.md)

## Context
The review of #31 (security lens) found that the read-only reviewer agents, `taster` and `brett`, have `Read`, `Grep` and `Glob` tools that are not limited to the checkout. Their input is a pull request's diff and text, which is untrusted. Text injected into a pull request could make a reviewer read a file such as `~/.config/gh/hosts.yml` and quote it in a finding. #31 mitigates this by scanning the summary before it is posted; #40 asks for the structural fix:
- a `PreToolUse` hook for `Read`, `Grep` and `Glob` that allows only paths inside the checkout, the review bundle under `.foedrum/tmp/` included;
- path checks that resolve `..`, links and junctions, Windows short names (`PROGRA~1`) and case;
- the same rule in the brewer runner's per-attempt settings (architecture §10, "Brewers acting outside their worktree").

Claude Code reads files outside the working directory without asking. Two questions were open: does the rule apply to every session or only to the reviewer agents, and how do brewers get it?

## Decision

### The read guard
`scripts/read-guard.ts` is a `PreToolUse` hook. For `Read`, `Grep` and `Glob` it lets a call through only when every path the call reads resolves inside `CLAUDE_PROJECT_DIR`, the project root Claude Code exports to hooks. It exits 0 at once for any other tool. Otherwise it blocks with exit 2 and one line that names the path, what it resolves to when that differs, and the checkout.

- **What it checks.** For `Read`, the `file_path`. For `Grep`, the `path`, or the working directory when there is none. For `Glob`, the `path` (or the working directory) and the literal part of the `pattern`: the folders before the first segment with a wildcard, from the root when the pattern is absolute or starts with `~`. A pattern without a wildcard is checked as a path. In an absolute pattern that starts with the checkout, the checkout's own folders are literal, so a `(` or `+` in their names (`OneDrive (EU)`, `c++`) is not read as a wildcard. A pattern that has `..`, an alternative starting at a root or the home folder (`{/etc,src}`), or a drive after a wildcard is blocked, because what it reaches cannot be read from its text.
- **How a path is resolved.** A leading `~` or `~/` is the home folder; `~user` is blocked. A relative path is relative to the hook input's `cwd`, and it is blocked when there is none. Then `realPath` (`src/platform/real-path.ts`) resolves it with `realpathSync.native` on the deepest part that exists and appends the rest. That follows links and junctions and expands short names, and on Windows it gives the case as stored on disk. The path is not normalised first. The operating system reads `link/..` its own way: Windows drops the pair before it looks at the disk, while POSIX goes to the parent of the link's target. So a lexically cleaned path could name a different file from the one the read would open. A tool may still clean the path before it opens it, so a path with a `..` segment must land inside both ways: as the operating system reads it, and normalised first and then resolved. A pull request can commit a link `x -> a/b/c` for `x/../../../etc/passwd`, which is inside one way and outside the other. For the same reason the guard and `realPath` build these paths as strings, not with `node:path`, which would normalise them. That is a deliberate exception to CLAUDE.md's rule that paths go through `node:path`. The checkout is resolved the same way, and the two are compared as strings with a separator after the checkout, so `/repo-evil` is not inside `/repo`.
- **On Windows**, a path without a full drive (`\x`, `/d/x`, `D:x`), a network path and a device path (`\\server\share`, `\\?\`, `\\.\`) are blocked before they touch the disk. That includes a relative path in a working directory on a network share, and a Glob pattern whose literal part starts at a drive without a folder (`E:x\*`), which is checked first. A path on a drive other than the checkout's, as given in `CLAUDE_PROJECT_DIR` or as resolved (a subst drive), is outside and is blocked the same way, so a mapped network drive is never opened. What is still resolved is a link inside the checkout whose target is a network path: `realpathSync.native` follows it, so Windows connects to that server before the guard finds the path outside.
- **Fail closed.** Any of these blocks the call: input that is not JSON, a missing `file_path` or `pattern`, `CLAUDE_PROJECT_DIR` unset or relative, or a path that cannot be resolved (`EACCES`, `ELOOP`). The hook is wired like the local gate (ADR 0045): `node "${CLAUDE_PROJECT_DIR}/scripts/read-guard.ts" || { …; exit 2; }` through bash with `onFailure: block`, so a missing node or script, or a crash, blocks too.
- **Fast exit.** As in `scripts/precheck.ts`, the module has no static imports. A guarded call loads `node:path`, `node:os` and `real-path.ts`, and nothing else.

### Only the read-only agents
The guard is wired in the frontmatter of `.claude/agents/taster.md` and `brett.md` (`hooks.PreToolUse`, matcher `Read|Grep|Glob`), not in `.claude/settings.json`. Claude Code runs an agent's frontmatter hooks only while that agent runs.
- For an agent whose only tools are `Read`, `Grep` and `Glob`, the guard is the boundary: nothing else it can do reads a file. A unit test finds every agent in `.claude/agents/` with only those tools and requires the hook block in its frontmatter, so a new read-only agent cannot be added without it.
- A main session has `Bash` and `PowerShell`, so a read guard is no boundary there: `cat ~/.config/gh/hosts.yml` reads the same file. A main session also has good reasons to read outside the checkout. Claude Code saves long tool results under `~/.claude/` and points the session at them, and the session's memory lives there too. In every session the guard would block these, add a node start (about 0.25 s, below) to every read, and protect nothing.

### Brewers: rules scoped to the worktree, not the hook
The brewer runner passes `--safe-mode` (ADR 0046), and **`--safe-mode` turns off the hooks of the `--settings` file as well**. Verified against `claude` 2.1.301 with the fake Messages API (`test/integration/read-guard.test.ts`). With the read guard in the attempt's settings file, a brewer's `Read` of a file next to its worktree gets the file under the runner's full command line, and is blocked when only `--safe-mode` is left out. Dropping `--safe-mode` would let in what it keeps out: `CLAUDE.md`, skills, plugins and MCP servers. So brewers do not get the hook.

They get the same rule from Claude Code's own permission rules. Under `dontAsk` (ADR 0042), a call that no allow rule matches is denied. Verified the same way, with `--safe-mode`:
- `Read(./**)` (relative to the working directory, which is the attempt's worktree) allows a read inside the worktree. It denies a read outside, a `../` path and a read through a junction that leads outside.
- `Read(./**)` also governs `Grep` and `Glob`. With `Grep` and `Glob` among `--tools` and no rule of their own, a search inside is allowed. A `Grep` or `Glob` with a `path` outside, and a `Glob` with an absolute pattern outside, are denied.
- A bare `Grep` rule allows a search of a folder outside again. So does a bare `Glob`.
- `Read(/**)` is relative to the settings file's folder, not the root.

So `attemptSettings` is to turn the brewer's bare `Read`, `Edit` and `Write` rules into `Read(./**)`, `Edit(./**)` and `Write(./**)`, and a bare `Grep` or `Glob` rule into `Read(./**)`: `--tools` already decides which tools exist. The `AttemptSettings` refinement is to refuse a bare file-tool rule. A rule anchored at `/`, `//` or `~`, or with a `..` segment, already needs the same rule in the permission ceiling (ADR 0026). This is a change to the runner, in #135, with its own test against the installed `claude` for `Edit` and `Write`.

## Consequences
- A reviewer told by a pull request to read `~/.config/gh/hosts.yml`, `../../x` or a file behind a junction or a short name gets a one-line refusal instead of the file. The unit tests cover both path styles on every platform, and the integration tests cover the hook command through bash, a real junction or link, `C:\PROGRA~1` and a short name inside the checkout (where the drive has short names), and the installed `claude`.
- Everything inside `CLAUDE_PROJECT_DIR` stays readable, `.git/` included, with the remote URLs in its `config`. A session started in the main checkout also lets its reviewers read every worktree under `.claude/worktrees/`. Both are the user's own repository.
- `Grep` and `Glob` search the tree they are given. A link inside the checkout that leads outside is checked when a path names it. It is not checked when a search of a parent folder reaches it. A reviewer cannot make such a link, but a pull request can commit one: git checks symbolic links out on macOS and Linux, and on Windows with `core.symlinks`. So the guard relies on `Grep` and `Glob` not following links. Verified against `claude` 2.1.301 on Windows with a junction: a `Grep` of the worktree does not find text behind it, and a `Glob` of `**/*.txt` does not list the files behind it. The test runs wherever `claude` is on PATH, with a directory link on macOS and Linux. If a later version follows links, that test fails.
- The guard costs a node start per reviewer read: about 0.15 to 0.25 s on Windows (see Verification). Reviews make tens of reads, so that is seconds per review. Other sessions pay nothing.
- The agent files load when a session starts, so the guard takes effect after a restart (CLAUDE.md, "Restarting a session"), and project agent hooks run only in a trusted workspace.
- The guard reads a path as Claude Code passes it to the tool. If a later Claude Code version reads paths differently (for example by expanding variables), a path could resolve one way for the guard and another way for the tool. The integration test against the installed `claude` is where that would show.
- Until #135 lands, a brewer's bare `Read` still reads outside its worktree. Real brewers do not run yet.

## Alternatives considered
- **The guard in `.claude/settings.json` for every session:** no boundary for a session with a shell, it blocks reads that sessions need (saved tool results, memory), and it costs every session a node start per read.
- **One hook in `.claude/settings.json` that acts only when `agent_type` is a reviewer:** it would work, because settings hooks also run inside subagents and the input names the agent. But every session would pay the node start to learn that it does not apply, and the rule would sit away from the agents it is for.
- **Permission rules for the reviewers too** (`Read(./**)` and no bare tools): interactive sessions are not in `dontAsk`, so a read that no rule allows would ask the user instead of being refused. The agents' tools also come from their `tools:` list, not from rules.
- **Drop `--safe-mode` from the brewer runner so that the hook runs:** it would bring back the repository's `CLAUDE.md`, skills and MCP servers, which ADR 0046 keeps out.
- **Normalise the path, then compare without resolving links:** a junction or link inside the checkout would lead anywhere.
- **Compare case-insensitively on Windows and macOS:** on a case-sensitive volume (Linux, a case-sensitive APFS volume, a Windows folder with case sensitivity on), two names that differ in case are two folders. After `realpathSync.native` the case is the disk's, so an exact comparison never lets an outside path through, and it blocks at worst.

## Verification
The cost per call, measured as in #41: 30 rounds after one warm-up, with the commands taking turns within each round and real hook JSON on stdin (Windows 11, Node 24.20.0, Git Bash 5.3). The machine is shared with other sessions, so absolute numbers vary between runs. The script is not committed.

Both runs waited for CPU load under 30 %.

| Command | Run 1 median | Run 1 p90 | Run 2 median | Run 2 p90 |
|---|---|---|---|---|
| `node -e ""` (baseline) | 97 ms | 185 ms | 85 ms | 166 ms |
| `node scripts/read-guard.ts`, a `Read` inside | 205 ms | 334 ms | 195 ms | 273 ms |
| `node scripts/read-guard.ts`, a `Read` outside | 252 ms | 363 ms | 181 ms | 343 ms |
| `node scripts/read-guard.ts`, a `Glob` inside | 238 ms | 407 ms | 183 ms | 328 ms |
| the agents' hook command through Git Bash `bash -c`, a `Read` inside | 320 ms | 550 ms | 256 ms | 486 ms |
| `bash -c true` (bash alone) | 49 ms | 93 ms | 44 ms | 72 ms |

- A guarded read costs about 0.1 s over bare node, and about 0.25 s per read as Claude Code runs the hook (through bash).
- In a third run (medians): an empty `.ts` file cost 52 ms over `node -e ""`, because type stripping starts for any `.ts` entry point. A tool the guard lets through at once cost 36 ms more, which is loading the guard's own module. A guarded `Read` cost 27 ms more again, for the lazy imports and `realpath`. The baseline was higher on this machine than in #41 (48–60 ms), so compare the differences, not the absolute numbers.
