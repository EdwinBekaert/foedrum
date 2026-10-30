# 0272. The status comment names a pull request once and breaks its path per round

Date: 2026-10-30 · Status: Accepted · Amends [0154](0154-lane-labels-on-the-order-s-issue-and-the-status-comment-s-path-line.md) (the path on one line), [0198](0198-an-open-pull-request-is-merge-tree-checked-when-its-base-moves.md), [0203](0203-an-open-pull-request-s-checks-run-on-its-merged-tree-when-its-base-moves.md), [0213](0213-an-open-pull-request-s-checks-on-its-head-are-recorded-once-they-finish.md), [0225](0225-a-ready-pull-request-gets-a-merge-brief.md), [0227](0227-a-later-round-renders-the-pull-request-s-body-again-unless-someone-edited-it.md), [0229](0229-a-merge-brief-whose-head-moved-is-hidden-as-outdated.md) and [0230](0230-open-pull-requests-of-one-repository-are-merge-tree-checked-against-each-other.md) (their lines join the pull request's one line), and [0123](0123-foedrum-brew-drives-one-batch-under-an-owner-of-its-own.md) (what `foedrum brew` prints on tap)

## Context
Read by a newcomer, `npm run demo` and the status comment it shows were hard to take in (#662):
- The status comment named the pull request twice: `- <url>`, then `- <url> is not ready to merge yet: no merge brief.`. ADR 0225, 0227 and 0229 each added a line of its own under the pull requests, and the check lines (ADR 0198, 0203, 0213, 0230) did too, so a pull request with a pending check, a conflict and no brief took three lines.
- The path was one line of 19 attempts (ADR 0154; ADR 0261 kept it one line). With 0261's reasons it reads well, but the two times the demo's batch went back were hard to find in it.
- `foedrum brew` said on tap twice in a row: its lane line `batch 2-1 on tap: <url>` (ADR 0123), then its last line `batch 2-1 is on tap: <url>`.
- A cleanup notice listed every worktree it removed and every branch it deleted: one line of about 40 items, from `foedrum serve` and `foedrum brew` alike.

## Decision
- **One line per pull request.** Under **Pull requests**, each of the batch's pull requests is named once, `- <url>`, followed by everything the comment says of it, each clause as before without the `- <url>` that started it, joined with `; `: its base check, the open pull requests it conflicts with, the checks on its head, its merge brief, and the body left as it is. A pull request with nothing to say keeps the bare `- <url>`.
  - The brief's line without one reads `is not ready to merge yet: no merge brief`, without the full stop.
  - ADR 0227's line reads `is left as it is: its description was edited since Foedrum wrote it` (or `has no Foedrum marker`), so it joins the others as a clause.
  - The lines the other readers take from the same helpers (`baseCheckLines`, `checkLines`, as the merge brief's evidence shows them) are unchanged.
- **The path, a line per round.** An attempt that a route scheduled (a failed check's or a findings route, or a failing check on the open pull request, ADR 0219), and not a retry or an answer, starts a line of its own beginning `→ `; the first line still begins `Path: `. The attempts one route scheduled together stay on one line. A batch that never went back keeps one line.
- **A cleanup counts.** A cleanup notice says how many worktrees it removed and how many branches it deleted (`removed 19 worktrees; deleted 18 branches`), then names every other thing it did, everything it kept with its reason, and everything it could not clean, as before. A cleanup with nothing to remove still says `nothing to remove`.
  The other things it did stay named: the batch folder and its attempt settings come once per batch, and the rarer ones (a pruned record, a stale `index.lock`, a folder git did not know) are what a person may want to look into.
- **`foedrum brew` says on tap once.** It prints no lane line for on tap, since its last line names the pull requests once the batch's last effects are applied; a stop before then still names the lane on tap.

## Rejected
- Breaking the path at a fixed width. It splits a round anywhere, and the reader still has to find where the batch went back.
- A `--verbose` flag for the full cleanup list. Worktrees and branches are one per attempt, so the path and `foedrum replay` already name each one; what needs a person (a kept item, a failure) is still named.
- Keeping the bare `- <url>` and dropping only the brief's line. A pull request with a conflict and no brief would still take two lines.

## Consequences
- The status comment shrinks by a line or more per open pull request, and a long batch's path reads round by round.
- A cleanup's notice no longer names which worktrees and branches it removed; nothing records them apart from the attempts.
