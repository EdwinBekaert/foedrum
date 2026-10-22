# 0116. The driver records each attempt's session, and claude's report goes on step.finished

Date: 2026-10-22 · Status: Accepted · Amends [0019](0019-interactive-sessions-and-one-command-layer.md) (what an attempt's session record holds, who writes it and when)

## Context
[ADR 0019](0019-interactive-sessions-and-one-command-layer.md) has every brewer attempt record its Claude Code session in the event store: the session id, the session it resumed, the worktree path and the Claude Code version. `answer` and `retryMode: resume` need it to resume the right session (#169). The schema had it (`SessionRef`, an optional `session` of `step.started`) and the fold kept it, but nothing wrote it: the driver recorded `step.started` with the worktree only, and the attempt plan drew a fresh `randomUUID` for `--session-id` when the runner started ([ADR 0042](0042-the-claude-command-line-and-stream-contract.md) had already moved the choice of the id from the stream to the runner).

Two of `SessionRef`'s fields are known at different times. The id and the worktree are Foedrum's own before claude starts. The Claude Code version is claude's to report, in its init event ([ADR 0046](0046-only-the-runners-settings-the-init-check-and-a-line-by-line-stream.md)), after `step.started` is recorded; the runner's end already carries it with the model (`AttemptEnd.session`, [ADR 0047](0047-the-claude-brewer-runner-its-stream-endings-and-progress.md)). The version is not needed to resume: it is for diagnosis, since a change in claude's behaviour between versions is a real cause when an attempt goes wrong.

What resuming needs was checked in Claude Code's docs (code.claude.com, 2026-10-22):

- **CLI reference, `--resume`:** "When you pass a session ID, Claude Code searches the current project directory and its git worktrees, then every other project on this machine. Before v2.1.223, the ID search covered only the current project directory and its git worktrees." It also accepts the absolute path of a session's `.jsonl` transcript.
- **Manage sessions, "Where transcripts are stored":** transcripts are at `~/.claude/projects/<project>/<session-id>.jsonl`, where `<project>` is the working directory with non-alphanumeric characters replaced by `-`; `CLAUDE_CONFIG_DIR` moves the storage, and `CLAUDE_CODE_PROJECT_DIR_NAME` (with it) names the project folder. "Resume by session ID or name" resolves an id in another project only when exactly one other project holds it, else `No conversation found with session ID: <id>`. Retention is `cleanupPeriodDays` in `settings.json`, 30 days by default.
- **The runner's settings:** `--setting-sources ""` (ADR 0046) chooses which settings files load, not where transcripts go, and the runner sets no config directory of its own: `brewerBaseEnv` passes the user's `CLAUDE_CONFIG_DIR` through when it is set ([ADR 0063](0063-foedrum-serve-its-configuration-and-wiring.md)). So a brewer's transcript is under the user's config directory, in the project folder of its worktree, and it keeps the default 30 days, since no user settings file is read.

So the id alone finds the session on the same machine, with the same config directory, from any folder (claude ≥ 2.1.223), and first from the worktree itself. The worktree is still needed: the session's history names that worktree's paths, so a resumed attempt runs there ([ADR 0029](0029-attempt-worktrees-layout-claims-and-repair.md)).

## Decision
- **The driver chooses the session id** of a brewer's attempt and records `session: { id, worktree }` in its `step.started`, in the same event as its `worktree`, before the runner starts claude. `session.worktree` is the attempt worktree's path. The attempt plan reads the id back from the state, as it reads the worktree, and passes it with `--session-id`; a started attempt with no session has no plan. The runner's init check (ADR 0046) still holds claude to that id.
- **Only an attempt that runs a brewer has a session**: the driver's `brews` decides, every attempt with a worktree by default; `foedrum serve` leaves out its check steps, which run no claude ([ADR 0069](0069-check-steps-run-the-repositorys-commands-in-an-attempt-of-their-own.md)). An action attempt has no worktree and no session, and an attempt whose worktree could not be made has neither.
- **`claudeVersion` leaves `SessionRef`.** What claude reported in its init goes on the attempt's `step.finished` as `claude: { version, model }`, optional: a run that ended before claude's init has none, which is itself the diagnosis. The session id stays on `step.started` only.
- `session.resumes` stays as it is, unwritten, for the resumed attempt (#326). Nothing resumes yet: the loader still refuses `retryMode: resume` ([ADR 0059](0059-attempt-plans-from-the-brewer-of-the-step.md)), and an answer still reaches a fresh attempt as its `answers` input.

## Consequences
- Every brewer attempt's session is on the state branch from its start, so a later attempt, a takeover or `/foedrum:resume` can find it, also when the process died before its first line.
- `SessionRef` drops a required field. No stored event carries a session yet, since nothing wrote one, so no store or state branch holds an event the new schema refuses.
- A session on another machine, or under another config directory, is not found by its id; ADR 0019's fallback (a fresh attempt with the answers) covers it, and the transcript path is the route a later spike may take.
- A transcript older than 30 days is gone; a batch that waits that long falls back the same way.

## Alternatives considered
- **The plan keeps choosing the id, and the runner reports it:** the id would reach the log only when the attempt ends, or not at all for a run that never ends (a driver killed mid-attempt), which is the case a resume most needs.
- **Record claude's version in `step.started`:** claude reports it only after it starts, so the start would wait on claude, or be written twice.
- **Record the transcript's path instead of the worktree:** it depends on how Claude Code names its project folders, which Foedrum does not control; the id and the worktree are enough on the same machine.
