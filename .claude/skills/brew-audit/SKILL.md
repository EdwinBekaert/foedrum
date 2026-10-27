---
name: brew-audit
description: Audit Foedrum's code and ADRs at one commit - security, architecture, over-engineering, complexity, smells, AI slop and tests - with an auditor per area and a skeptic per auditor, and write one ranked report. Run by hand or by /brew-last-call; finding nothing is a valid result.
argument-hint: "[--since <sha> | --full]"
---

# Audit Foedrum's code

An audit reads the code as it stands, not a change: `/brew-review` judges a pull request, this judges the codebase. It runs the saved workflow `.claude/workflows/brew-audit.js`: one auditor per area (engine core, engine GitHub side, brewers and checks, CLI, I/O boundary, schemas, tooling), one for a sample of the tests and one for the ADRs; one skeptic per area tries to refute every finding; one agent writes the report from what survives. The auditors use the diff lenses in `defaults/lenses/diff/` as their checklists, so improving a lens improves both reviews.

Arguments: `$ARGUMENTS`

## Rules for the whole run

- **Read-only.** The audit reads a worktree pinned at one commit and changes nothing: no file, no branch, no issue, no comment. It files nothing: a person picks which findings become issues.
- **Finding nothing is a good result.** The workflow tells every auditor and skeptic so. Never ask for more findings, re-run to get some, or add findings of your own to the report.
- **Security findings stay local until fixed.** The report and its findings are written under the main checkout's `.foedrum/tmp/audits/` (git-ignored), never into a commit, a pull request or an issue body as they are. When a caller puts the audit's outcome in public text, it gives counts per severity and per area, and names a security finding only by "a security finding in <area>".
- **Paths.** `<main>` is the main checkout: the folder above `git rev-parse --path-format=absolute --git-common-dir`. Audits live in `<main>/.foedrum/tmp/audits/<sha>/`.

## Stage 1: the commit and the mode

1. `git fetch origin`. `<sha>` is `git rev-parse origin/main`, and it must match `^[0-9a-f]{40}$`. `<repo>` is `owner/name` from `gh repo view --json nameWithOwner --jq .nameWithOwner`.
2. If `<main>/.foedrum/tmp/audits/<sha>/report.md` exists, this commit was audited already: print its path and stop.
3. The mode:
   - `--full`: the whole codebase.
   - `--since <base>`: `<base>` must match `^[0-9a-f]{40}$`, and `<main>/.foedrum/tmp/audits/<base>/findings.json` must exist; else stop and say which is missing.
   - neither: the newest earlier audit whose commit is an ancestor of `<sha>` (`git merge-base --is-ancestor <base> <sha>`, newest by `git log -1 --format=%ct <base>`) is `<base>`; with none, the whole codebase.
4. Say which mode and why before going on: a full audit is about 19 agents and a few million tokens; one since an earlier audit costs less, in proportion to what changed.

## Stage 2: the pinned checkout

`git worktree add --detach .claude/worktrees/audit-<sha8> <sha>` from `<main>`, where `<sha8>` is the first 8 characters. `<root>` is its absolute path. No `npm ci`: the audit runs nothing.

## Stage 3: the workflow

Run the Workflow tool with `name: "brew-audit"` and `args`:

```json
{ "root": "<root>", "sha": "<sha>", "repo": "<repo>", "since": "<base>", "previous": <findings.json of <base>, as an array> }
```

leaving out `since` and `previous` for a full audit. It runs in the background; wait for its notification. If it ends with `missing` areas, say which in the summary; do not re-run them by hand.

## Stage 4: the report

1. Write the workflow's `report` to `<main>/.foedrum/tmp/audits/<sha>/report.md` and its `findings` to `findings.json` there, with the file tool, unedited.
2. Remove the pinned worktree: `git worktree remove .claude/worktrees/audit-<sha8>`.
3. Print: the mode, the counts of kept findings per severity and per area, how many were dropped, the three things the report says are most worth doing, and the path of `report.md`. Then stop: what becomes an issue is the person's choice.
