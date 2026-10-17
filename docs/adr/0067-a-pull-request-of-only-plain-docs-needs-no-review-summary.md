# 0067. A pull request of only plain documentation needs no review summary

Date: 2026-10-17 · Status: Accepted · Amends [0060](0060-the-gate-refuses-gh-pr-ready-without-the-review-summary.md) (what `gh pr ready` needs)

## Context
Since ADR 0060 the gate refuses `gh pr ready` until the pull request has a `/brew-review` summary for its head. That is right for code, ADRs and prompts, but #181, a one-line rename in `docs/milestones/README.md`, needed a whole review session for nothing: the review's red proof, mutation check and coverage delta have no code to work on, and its lenses add little to a reword of a plain document (#183).

## Decision
- **Plain documentation needs no summary.** `gh pr ready` passes, without a summary, a pull request whose files are all `*.md` in a subfolder of `docs/` other than `docs/adr/`, such as `docs/milestones/`. The match is on the path as GitHub lists it, ignoring case.
- **The top-level docs are reviewed.** `docs/architecture.md`, `docs/glossary.md`, `docs/brewers-and-recipes.md` and any other `*.md` directly in `docs/` are the design and the review's criteria: sessions are sent to them, and the review hands the glossary to every reviewer. A pull request that changes one needs its summary, so text planted in them cannot reach later prompts unreviewed.
- **Everything else is still reviewed:** ADRs, which record decisions; `CLAUDE.md`; anything under `.claude/` (skills, agents and prompts change behaviour); `README.md` and the other root files; and all code, tests and fixtures. One such file among plain docs makes the whole pull request need its summary.
- **The file list comes from the lookup the gate already makes.** `gh pr view` is asked for `files` and `changedFiles` too, so the exemption costs no extra call. A list that cannot be read, has an entry without a path, or is shorter than `changedFiles` (gh lists at most 100 files) counts as not exempt, and so does an empty one.
- **Renamed and copied files are not read.** GitHub lists them by their new path only, so `git mv CLAUDE.md docs/milestones/claude.md` would look like plain documentation. Only an entry whose `changeType` is `ADDED`, `MODIFIED` or `DELETED` counts; any other, or none, makes the list not exempt. The gate then needs the summary as before.
- The rest of ADR 0060 stands: the lookup, its failures, `--undo`, the blocked forms and the commands of their own all apply to a docs pull request as to any other.

## Consequences
- A pull request of only plain docs is marked ready without a review session; one that also touches a reviewed file is not.
- The exemption follows the paths, not what changed in them: a large rewrite of a document in `docs/milestones/` passes too. A change to the design is in the top-level docs or an ADR, which are reviewed.
- A pull request with more than 100 files needs its summary even when they are all plain docs, and so does one that renames or copies a file, even from one plain document to another.
- CLAUDE.md's rule to run the review skill before marking a pull request ready names the exception.

## Alternatives considered
- **Exempt every Markdown file:** `CLAUDE.md`, ADRs and the skills and agents under `.claude/` are Markdown that change how sessions and reviewers behave.
- **A separate `gh api` call for the files:** another 30 s call and another failure to handle, for a list `gh pr view` already gives.
- **A label or a comment that waives the review:** a session could add it as easily as it skipped the review in #154.
