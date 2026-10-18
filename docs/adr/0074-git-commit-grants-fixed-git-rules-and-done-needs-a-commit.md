# 0074. `git.commit` grants fixed git rules, and a commit-producing brewer's `done` needs a commit

Date: 2026-10-18 · Status: Accepted · Amends [0059](0059-attempt-plans-from-the-brewer-of-the-step.md) (what the plan's permissions and prompt hold, and `requiresCommits` loads) and [0028](0028-brewer-runner-outcomes-environment-and-test-first.md) (one more rule in `settleAttempt`)

## Context
A brewer with `"produces": "commits"`, `"access": "write"` and `"git": { "commit": true }` passes its schema, but nothing turned `git.commit` into anything (#196). The attempt plan ([ADR 0059](0059-attempt-plans-from-the-brewer-of-the-step.md)) allowed only the brewer's `tools.allow` and the repository's toolchain rules, and the out doc contract said nothing about committing. In the first live run the brewer's settings allowed `Read` and `Write`; it changed the file and wrote "Not committed or pushed". The engine then took the `done` at its word: `settleAttempt` succeeded, `decide` went on to the next step, and the task tree of the next attempt ([ADR 0066](0066-the-task-tree-continues-from-the-latest-succeeded-attempt.md)) was the start commit again, because uncommitted files do not carry over. The change was lost without a word.

#196 offered two ways: the runner adds fixed git rules and the prompt says to commit, or the engine commits the worktree itself after a `done` out doc and `git.commit` goes.

Two rules bound the first way. [ADR 0062](0062-brewers-never-allow-git-with-no-fixed-subcommand.md): a brewer is never allowed git with no fixed subcommand, and the subcommand must not push. [ADR 0026](0026-how-a-permission-ceiling-covers-a-rule.md): the permission ceiling bounds the rules the Brewery does not write itself, today a repository's toolchain rules, later a pack's.

## Decision

### What `git.commit: true` grants
- **Three fixed rules, in Bash.** `planAttempt` adds `Bash(git status *)`, `Bash(git add *)` and `Bash(git commit *)` to the allowlist of an attempt whose brewer has `git.commit: true` (`gitRulesOf`, `src/brewers/attempt-plan.ts`), after the brewer's own rules and before the repository's, each once. `--tools` follows from the rules, so the brewer gets the Bash tool. Bash and not PowerShell: claude has Bash on every platform (Git Bash on Windows), and its PowerShell tool needs a variable the runner does not set (ADR 0062).
- **Why these three.** `add` and `commit` are what committing takes; `status` is what a model runs first, and a denial of it would count towards `maxDenials`. Nothing else: `git diff --no-index` and `git log --output` read or write any file of the machine, and a brewer that wants `diff` or `log` names them in its own `tools.allow`, where the review of the brewer file sees them.
- **Within ADR 0062.** Each rule names its subcommand, and none of them pushes, so `reachesAnyGitCommand` passes them and the settings schema, which checks the whole allowlist again, keeps them. The deny rules `Bash(git push *)` and `PowerShell(git push *)` stay as they are.
- **Within the ceiling.** The rules are the brewer's own: `git.commit: true` is a line of the brewer file, written by the Brewery, and the three rules it stands for are fixed in the engine. The ceiling does not bound a Brewery's own brewer files ([ADR 0026](0026-how-a-permission-ceiling-covers-a-rule.md)), so it does not bound these rules, and a ceiling never needs `Bash(git *)` for a brewer to commit. When packs come (architecture §12), a pack's brewer is held to the pack's ceiling, and these three rules count as its rules: such a brewer needs them covered as any other.
- **A brewer without `git.commit`** gets none of them. `git.commit: false` does not take away a git rule the brewer lists itself; that stays the brewer file's choice, within ADR 0062.

### What the out doc contract says
The contract of a brewer with `git.commit: true` gets one more sentence before its last line: `Commit your changes with git add and git commit before you write <out doc>, and leave <out doc> out of every commit.` The out doc is the engine's record of the attempt, not part of the change, and a pull request would carry it. The contract of every other brewer is unchanged and stays within its 1,200 characters; the longer one is held to 1,400 (brewers-and-recipes §2).

### A `done` with no commit
- **The runner counts.** For an attempt of a brewer that produces commits, `limits` gives the commit its worktree started at (`commitsSince`, the `commit` of the `step.started` worktree, [ADR 0029](0029-attempt-worktrees-layout-claims-and-repair.md)). After the stream ends, the real runner asks git in the worktree whether that commit is an ancestor of `HEAD` (`git merge-base --is-ancestor`) and how many commits lie between them (`git rev-list --count <commit>..HEAD`), through `countCommits` (`src/workspace/attempt-commits-git.ts`) with the runner's signal. The fake runner takes the count from its script.
- **`settleAttempt` reads the count only for a `done` out doc**, the last rule before success:
  - no commit since the start: `blocked` on a `divergence`, `the out doc says done, but the brewer made no commit since <sha>: <summary>`. The step's work did not reach the task tree, so the next step would start without it; a human sees the brewer's own summary and retries, skips or rewinds. Not a retryable failure: a brewer that found nothing to change would find it again and spend its attempts;
  - the start is no ancestor of `HEAD` (`git commit --amend` of the start commit): a failure that is retried, `the brewer rewrote <sha>, the commit its worktree started at`. The pushed branch would replace a commit of the base;
  - git could not answer (or nothing counted): `blocked` on the `environment`, `the commits since <sha> were not counted: <reason>`.

  A `needs_input`, `blocked` or `failed` out doc is read as before, with or without commits.
- **`requiresCommits` loads.** It is this check, and every brewer that produces commits now has it, listed or not. Its exception in brewers-and-recipes §1.1, "unless the out doc says no change was needed", goes: the contract has no key for it, and a step that changed nothing is the divergence above.

## Consequences
- The docs' example brewer and `test/helpers/serve-brewery.ts`'s cellarman commit with `Read`, `Write` and `git.commit: true`; the example's own `Bash(git add*)` and `Bash(git commit*)` go, and its `Bash(git diff*)` stays as a rule of its own.
- `test/integration/attempt-plans.test.ts` runs a commit-producing brewer, configured as the docs show, through the real `claude` against the fake Messages API (opt-in with `FOEDRUM_REAL_CLAUDE=1`, ADR 0057): its "model" writes a file, runs `git add` and `git commit` through Bash, then writes the out doc, and the attempt succeeds with the commit on the attempt's branch. A second run without the commit ends Stuck on the divergence.
- `git commit` reads the git identity of the clone, so a clone without `user.name` and `user.email` (the user's global config, which the brewer sees through `HOME`) fails the commit. The brewer then reports it, or ends `done` and gets the divergence. Setting an identity for brewers is not decided here.
- What a commit runs in turn is out of the rules' reach, as ADR 0062 says: the clone's hooks, and an option of `git commit` that reads a file, such as `-F` or `--template` with a path outside the worktree, which would put that file into a commit message and so into a pull request. No deny rule holds against quoting (ADR 0062); the isolation level ([ADR 0010](0010-cross-platform-and-isolation-levels.md)) is what keeps the brewer's shell inside its worktree. A brewer that lists `Bash(git commit*)` itself, as the docs' example did, had the same reach.
- A brewer can still commit the out doc against the contract, or leave other changes uncommitted after its commits. The engine does not check either yet.
- A `done` from a commit-producing brewer costs two git calls in its worktree after the stream, with the runner's signal.

## Alternatives considered
- **The engine commits the worktree after a `done`** (`git add -A`, `git commit -m <summary>`): no git rule for the model at all, but one commit per attempt, with a message the engine makes up, and a test-first brewer could not make its red and green commits. The engine would also have to tell the out doc and scratch files from the change, and a commit it makes in a worktree it does not own is a side effect outside the ledger.
- **Rules for every git subcommand a brewer might want** (`diff`, `log`, `show`): `diff --no-index` and `log --output` reach any file, and each one more is one more to check against ADR 0062.
- **PowerShell rules too, on Windows:** the PowerShell tool is off in the runner's sessions, and two shells double the rules ADR 0062 has to hold.
- **A retryable failure for a `done` with no commit:** a brewer that found nothing to change would spend every attempt finding it again before the batch went Stuck.
- **Count commits from the stream** (the commits the runner saw, ADR 0047): a commit that failed after the tool call reported success, or one made by a script, would count wrong; git in the worktree is what the next step starts from.
