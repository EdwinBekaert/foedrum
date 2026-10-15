# 0029. Attempt worktrees: layout, claims and repair

Date: 2026-10-15 · Status: Accepted · Details [0012](0012-worktrees-from-local-clones.md)

## Context
[ADR 0012](0012-worktrees-from-local-clones.md) gives every attempt its own git worktree in a work root outside the Brewery checkout, from the user's clone (`source: local`) or a managed bare partial clone (`source: managed`), and asks Foedrum to clean up when a batch ends and to repair after crashes. It leaves open where in the work root a worktree goes, what its branch is called, what decides that a worktree may go, and how a cleanup stays out of the user's way when the user's clone is shared with Foedrum, possibly by more than one Brewery. A cleanup that guesses wrong deletes someone's work; one that is too careful leaves debris on every crash.

## Decision

### Layout
- A repository's folder in the work root is `<owner>.<name>`, in lower case; the managed clone is `clone.git` in it, and the attempt worktrees are below `attempts/`: `<workRoot>/<owner>.<name>/attempts/<batchId>/<stepId>/<attempt>`. The branch of an attempt is `foedrum/<batchId>/<stepId>/<attempt>`.
- Every segment Foedrum builds passes `PathSafeId` (ADR 0024). The ids must also be parts of a branch name, so an id with `..` or a `.lock` ending is refused, and so is a batch called `state`: `foedrum/state` is the state branch. A repository whose folder name would not pass (longer than 64 characters, or a name that ends in `-` or `.`) is refused with that reason.
- One folder per repository keeps each clone's cleanup to its own worktrees: a folder in the attempts root that the clone's `git worktree list` does not show is that clone's debris, not another repository's.
- A managed clone is cloned into `clone.partial` and renamed when done, so a crash leaves no half clone in its place. Its fetch refspec maps branches to `origin/*`, as in any clone, so a fetch never moves Foedrum's own branches.

### Creating
- `create` fetches the remote (no prune), resolves the base to a commit and adds the worktree with `git worktree add -b`. It never touches the user's checked-out branch, and never resets a branch (`-B`).
- A start that crashed before the brewer ran leaves the same attempt's worktree: `create` reuses it when it is clean, on the attempt's branch and at the base. It refuses anything else in the way (a folder git does not know, a worktree with changes or at another commit, the branch checked out elsewhere or at another commit), and the engine schedules a new attempt, whose names are new.
- `recreate` gives a resumed attempt its worktree back (ADR 0019): the one that is there, or the attempt's branch checked out again, or a new branch at the recorded commit when the branch is gone.

### Claims
- A cleanup gets the claims of the state: each batch it knows is **live** (Ordered, Brewing, Conditioning or Stuck) or **ended** (on tap or cancelled), and the attempts that hold a **live lease**.
- A worktree with a live lease is never removed, and its `index.lock` is never touched. Leases are renewed by the driver (the interactive session, later the Cellar), not by the brewer runner (#37): a lease says that a driver still owns the attempt, so it expires when the driver dies, even while an orphaned brewer process still runs. After that the attempt is lost (ADR 0027), and its worktree may go once its batch has ended; the removal's retries and the next repair deal with files the orphan still holds.
- A Stuck batch is live: a human may take over or resume, so it keeps its worktrees.
- In the attempts root, which is Foedrum's, everything of an ended batch goes, and so does everything of a batch the state does not know (an engine that died before the batch was pushed). Outside it nothing is looked at.
- Branches in a batch's namespace (`foedrum/<batchId>/…`, attempt branches and the local copy of a pushed bottle branch) go with an ended batch, unless a worktree outside the attempts root has one checked out or its attempt is leased. The branches of a batch the state does not know stay: another Brewery may share the user's clone and use the same batch ids. A branch that goes with its worktree is deleted only after the worktree is gone, and only while it still points at the commit the cleanup saw (`update-ref -d <ref> <tip>`).

### Cleaning up and repair
- One cleanup serves both: at engine start, before new work, over every batch (crash repair), and when a batch ends, over that batch only.
- How a worktree goes is the rule the worktree cleanup script already uses (`src/workspace/worktree-removal.ts`): remove a clean one with `git worktree remove`, finish a removal that stopped after deleting the `.git` file, prune a record whose folder is gone; robust removal through `removeTree` (read-only bits, `EBUSY`/`EPERM`/`ENOTEMPTY` retries).
- Kept and reported: worktrees with uncommitted or untracked changes, locked ones, ones that hold another worktree, and folders below the attempts root that are no attempt folder. A folder that git does not know as a worktree is removed with its ended batch. A batch folder goes once nothing but empty folders is left in it.
- Records are pruned only for worktrees in the attempts root, one by one. Foedrum never runs `git worktree prune` in the user's clone: it would drop the user's own stale records too.
- Kept worktrees that no attempt runs in (no live lease) get their stale `index.lock` removed (`removeStaleIndexLock`: older than a minute).
- Nothing it cannot remove stops the cleanup: it reports the reason and goes on; the next cleanup tries again. Facts it cannot gather (the worktree list, the branches) stop it, since a partial list would free what is in use.
- The pure core (`src/workspace/attempt-worktrees.ts`) decides from facts; the shell (`src/workspace/attempt-worktrees-git.ts`) gathers them and runs git through the injected runner (ADR 0021). `worktreeClaims` (`src/engine/worktree-claims.ts`) turns the folded state and the live leases into claims, so the workspace layer does not depend on the engine.

### Hooks
- `git worktree add` runs the clone's `post-checkout` hook. Unlike the state branch (ADR 0024), attempt worktrees keep the repository's hooks: brewers work and commit in them as a developer would.

## Consequences
- No batch that has ended leaves a worktree, a local branch or a worktree record behind, once its cleanup or the next repair has run, unless a human's changes are in it; those are reported.
- The user's checkout, its branches, its own worktrees and their records are never changed. Worktree folders of a repository are deeper by one level than the bare minimum, but stay well inside Windows' path limit for engine-made ids.
- Recording the worktree (path, branch, commit) in the attempt's events, wiring the cleanup into engine start and the end of a batch, and the chaos cases (#15) are follow-ups; the manager returns what to record.
- A bottle branch's name must not look like a step: `foedrum/<batchId>/<stepId>/…` belongs to attempts.

## Alternatives considered
- **Worktrees by batch only (`<batchId>/<stepId>-<attempt>`):** shallower, but the folder name could pass 64 characters and would not pass `PathSafeId`.
- **One attempts root for all repositories:** shorter paths, but a cleanup of one clone could not tell another repository's worktree from debris.
- **Remove everything unclaimed, also branches of unknown batches:** fewer leftovers, but deletes another Brewery's work in a shared clone.
- **Reset or delete what is in the way on `create`:** always succeeds, but may destroy work that is not the attempt's; a new attempt is cheap.
- **`git worktree prune` after removals:** simpler, but also prunes the user's own stale records.
