# 0266. The plan and status comments link the plan's out doc on the state branch

Date: 2026-10-30 · Status: Accepted · Amends [0233](0233-a-plan-is-an-out-doc-whose-paths-the-engine-checks-shown-as-one-comment-per-order.md) (the plan comment's text and its cut) and [0072](0072-the-status-comment-edits-as-revisions-in-the-ledger.md) (what the status comment's Assumptions show)

## Context
The status comment shows each assumption a brewer wrote cut to one line of about 200 characters, ten per step at most ([ADR 0072](0072-the-status-comment-edits-as-revisions-in-the-ledger.md)); the plan comment shows none, and its cells stop at about 200 characters ([ADR 0233](0233-a-plan-is-an-out-doc-whose-paths-the-engine-checks-shown-as-one-comment-per-order.md)).
The maintainer's first `foedrum mash` run showed that a plan's assumptions are what a person signs off, several of them design decisions, and the comments gave no way to the rest (#659).
The full text is the attempt's out doc on the Brewery's state branch, `batches/<batch>/<step>-<attempt>.md` on `foedrum/state` ([ADR 0024](0024-state-branch-layout-outbox-and-divergence.md), [ADR 0103](0103-out-docs-reach-the-state-branch-through-the-store.md)).
Its assumptions are in its JSON frontmatter, which GitHub's rendered view of a Markdown file does not show readably; `?plain=1` shows the file as written.
The maintainer decided on #658 that the comments link the out doc, and that the link must lead to a page where the assumptions can be read; how a plan should read as a whole is still #658's.

## Decision
- The plan comment ends with `Full plan: <https://<host>/<brewery>/blob/foedrum/state/batches/<batch>/<step>-<attempt>.md?plain=1>`, after the Gate section, for the attempt whose plan it shows.
- A cut keeps that line: the text before it is cut to leave room for it (`cutForComment(text, room)`), the graph still going first, so the comment with its link stays within `longestComment`.
- The status comment ends a step's assumptions with ``- `<step>`: full plan: <same link>`` when that step's latest succeeded out doc is a plan; another step's assumptions get no link, and a plan step with no assumption shown gets none, its plan comment carrying the link.
- The link names the branch, not a commit. An attempt's path is its own, and a flush writes it again only with the same text (ADR 0103), so the branch link keeps showing that attempt's plan after the branch moves on. A commit pin would need the store's pushed-through marker, which no fold reads (ADR 0024), so the renderers would no longer be functions of the folded state, and every comment would need one more revision once the push lands.
- The host is the Brewery's configured GitHub host (`github.hostname`), as `foedrum brew` builds its comment links, so a GitHub Enterprise Brewery links its own host.
- The driver's tick flushes the state branch first and applies the effects after it drives the batches (`tick`, `src/engine/driver.ts`). A comment for a `step.finished` just recorded is applied before the push that carries its out doc, so its link works from the next tick's push, seconds later, or once a failing push succeeds (ADR 0024's retry).
- `outDocLink` (`src/engine/state-branch.ts`) builds the link from `outDocPath`; the driver's wiring gives both effects the branch's address, `stateBranchUrl`.

Rejected:
- A blob link pinned to the state commit, which #659 first asked for: it ties the comments to the store's marker, as above.
- Showing the link only once the batch's events are pushed through: the same marker, for a gap of one tick.
- The assumptions in full in the comments: a plan's assumptions can be long, and the comments are cut to GitHub's length; #658 settles how a plan reads.

## Consequences
- Every plan comment and every status comment with a plan step's assumptions gets one more revision when this ships, since their text changes.
- An out doc the store could not keep (`keepOutDocs` reports one line, and the attempt still ends as its runner said, ADR 0103) never reaches the branch, and its link stays dead. That is rare and already reported; showing it would make the renderers read the store's outbox, which no fold reads.
- The link points at text no secret scan filtered (ADR 0103), in the Brewery repository that already holds it; the comments themselves still show only filtered text ([ADR 0088](0088-out-doc-text-that-looks-like-a-secret-is-left-out-of-the-pull-request-and-the-status-comment.md)).
