# 0301. A Brewery order's read-only attempt reads every repository in a checkout of each

Date: 2026-11-02 · Status: Accepted · Amends [0232](0232-foedrum-mash-routes-an-issue-to-the-innkeeper-whose-question-the-answer-chooses-the-recipe-by.md) (the Innkeeper of a Brewery issue runs in a Brewery of several repositories), [0234](0234-the-brewmaster-writes-a-plan-on-the-planner-alias-and-mash-runs-it.md) (the Brewmaster reads every repository of a Brewery order), [0063](0063-foedrum-serve-its-configuration-and-wiring.md) (`repositoryOf` is no longer asked for such an attempt), [0029](0029-attempt-worktrees-layout-claims-and-repair.md) (a folder of checkouts beside the attempts roots, which the cleanup removes), [0117](0117-a-retry-resumes-the-session-of-the-attempt-before-it-in-that-attempt-s-worktree.md) and [0175](0175-a-turn-overrun-is-retried-by-resuming-its-session-and-keeps-its-out-doc.md) (a resumed session gets its checkouts back, not a worktree), [0126](0126-foedrum-resume-opens-a-finished-attempt-s-session-in-its-worktree.md) (`foedrum resume` opens such an attempt in its folder) and [0233](0233-a-plan-is-an-out-doc-whose-paths-the-engine-checks-shown-as-one-comment-per-order.md) (a plan's paths are checked at each checkout's commit) · Amended by [0317](0317-the-planners-read-a-system-map-computed-from-each-repository-s-manifests-with-no-model.md)

## Context
A Brewery order is an issue in the Brewery, not a claimed issue of a target repository and not a sub-order, so it has no repository of its own.
`repositoryOf` ([ADR 0063](0063-foedrum-serve-its-configuration-and-wiring.md)) gave its attempts the Brewery's only repository, and threw `batch <id> names no repository, and the Brewery has <n>` with two or more.
The driver asks it before it makes an attempt's worktree, so the Innkeeper's `innkeep` and the Brewmaster's `plan` failed at once in any Brewery of several repositories.
ADR 0232 and ADR 0234 recorded that limit, and left "reading several repositories in one attempt" to a worktree change of its own.
M2's exit plans one order across two repositories (#739's ladder demo: a library and the app that calls it), and a plan of it must read both.
A brewer's file tools reach only its working directory, through no link or junction ([ADR 0093](0093-brewers-file-tool-rules-are-read-and-edit-rules-scoped-to-the-worktree.md)).
A brewer with `access: "read"` writes no commit, only its out doc.
Decided with the maintainer on 2026-11-02: every repository on an equal footing, each a read-only checkout at its base; writing attempts stay in one repository each.

## Decision
- **Which attempts.** An attempt whose brewer has `access: "read"`, in the recipe the attempt was scheduled under, of a batch with no repository of its own, in a Brewery that lists two or more repositories (the driver's `reads`, which the wiring sets from the brewer).
  Today that is the Innkeeper's `innkeep` and the Brewmaster's `plan` and `lauter`.
- **The folder.** Such an attempt runs in `<workRoot>/brewery-orders/<batch>/<step>/<attempt>/`, beside the repositories' folders, with one checkout per repository the Brewery lists, named by its alias, or by `<owner>.<name>` without one (an alias has no dot, so the two never meet).
  Each is a detached `git worktree add` from that repository's clone at its base, after the same fetch a new worktree gets (`AttemptWorktrees.checkout`).
  Claude's working directory is the folder, so `Read(./**)` reaches every checkout and no link is needed.
- **Recording.** `step.started` records `checkouts: [{ repo, path, commit }]` (two or more) in place of `worktree`, and `session.worktree` names the folder.
  A store from before this record reads as it did.
- **Resume.** A retry or an answer that resumes the session (`retryMode: "resume"`, [ADR 0117](0117-a-retry-resumes-the-session-of-the-attempt-before-it-in-that-attempt-s-worktree.md)), a turn overrun's retry ([ADR 0175](0175-a-turn-overrun-is-retried-by-resuming-its-session-and-keeps-its-out-doc.md)) and `foedrum resume` ([ADR 0126](0126-foedrum-resume-opens-a-finished-attempt-s-session-in-its-worktree.md)) make the same folder again, each checkout at its recorded commit; a checkout that is there and on no branch is used as it is.
  `foedrum lauter` starts its attempt through the driver ([ADR 0286](0286-foedrum-lauter-corrects-a-plan-at-gate-1-in-an-interactive-session.md)), so it gets a folder the same way.
- **Cleanup.** When the batch ends, and at a driver's start for every batch that is not live, each repository's cleanup removes its own checkouts under `brewery-orders/`, as a worktree is removed: kept while a live lease holds the attempt, while it is locked, or with changes.
  Then the attempt's out doc, which the brewer wrote in the folder, goes, and the batch's folder with it once nothing else is left in it; the last repository's cleanup empties it.
- **A writing step** of such an order fails without a retry: `step <id> writes, and a Brewery order in a Brewery of <n> repositories only plans: label it recipe:mash, or file it in its repository with the intake label`.
- **One repository.** A Brewery of one repository runs a Brewery order as before: one worktree of that repository, no folder.
- **The plan.** The attempt's plan runs in the folder with no repository of its own: no repository's tools or `setup`, and the plan's `touches` are checked in each repository at the commit its checkout was made at, the commit the brewer read, and at its base only for a repository with no checkout ([ADR 0233](0233-a-plan-is-an-out-doc-whose-paths-the-engine-checks-shown-as-one-comment-per-order.md)).
  What the brewers are told of the folder (the `repositories` input's text, the Brewmaster's and the Innkeeper's prompts) is #768's.

## Consequences
- `foedrum mash` plans a Brewery order in a Brewery of several repositories.
- Foedrum computes no knowledge about the repositories here; a system map is #765's.
- A Brewery order's attempt costs one fetch and one checkout per repository; a large Brewery pays for each, every attempt.
- A Brewery issue the Innkeeper sends to a writing recipe in a Brewery of several repositories fails at that recipe's first step, with the remedy in its reason.

## Alternatives considered
- **The attempt's worktree in the first-listed repository, with the others as checkouts in an ignored folder inside it**: smaller, but the first repository would look like the attempt's own, against an equal footing for every repository.
- **Links from one folder to each repository's worktree**: file tools refuse to follow a link or junction (ADR 0093).
- **Attempt branches for the checkouts**: a read-only attempt commits nothing, so a branch would only be one more thing to clean.
- **Refuse a writing step in `refuse` (the brewer runner's hook)**: a check step, which has no brewer, would not be refused there, and the driver already decides where an attempt runs.
