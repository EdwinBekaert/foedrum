---
paths:
  - "scripts/deps-sync.ts"
  - "scripts/deps-sync/**"
  - "test/**/deps-sync*.test.ts"
---

# Node modules at session start

A `git pull` that changes `package-lock.json` leaves `node_modules` stale, and the gate then fails for every session. So the first `SessionStart` hook in `.claude/settings.json` runs `npm run deps:sync` in `${CLAUDE_PROJECT_DIR}` when a session starts or resumes, synchronously: the session waits for it, so no gate runs against a half-installed tree.

- `scripts/deps-sync/core.ts` decides, `scripts/deps-sync.ts` reads the files and runs `npm ci` (ADR 0021). It compares the `packages` entries of `package-lock.json` (version and integrity, without the root entry) with npm's record of what it installed, `node_modules/.package-lock.json`. A missing record, a changed, added or removed package means stale. Entries marked `optional` or `peer` may be missing from the record, because `npm ci` skips optional packages for other platforms and peers under `omit=peer`.
- It prints nothing when `node_modules` is up to date (hook output goes into the session's context), one line when it ran `npm ci`, the end of npm's output when that failed, and one line when it could not run npm (`npm_execpath` not set) or failed itself. It never fails the session, and it never runs `npm install` or changes the lock file. `npm ci` gets 540 s, under the hook's 600 s, and its whole tree is killed at that deadline or when the hook is stopped.
- Claude Code starts the hooks of one event together, so the background worktree cleanup may run while `npm ci` does; that is safe because the cleanup loads no package from `node_modules`.
