# 0350. A brewed pull request is a draft until its merge brief, and the Next line follows the brief

Date: 2026-11-08 · Status: Accepted · Amends [0167](0167-a-brewed-pull-request-follows-one-layout-and-opens-as-a-draft-unless-every-taster-approves.md) ("Draft or ready by the Tasters' verdicts": every pull request opens as a draft), [0345](0345-a-pull-request-past-a-skip-says-so-and-an-ended-batch-s-status-comment-is-left-alone.md) ("These lines take the place of the one that says why it is a draft or ready", and "A ready pull request stays ready": the draft state changes with the brief), [0225](0225-a-ready-pull-request-gets-a-merge-brief.md) (the brief marks its pull request ready for review), [0229](0229-a-merge-brief-whose-head-moved-is-hidden-as-outdated.md) (a brief outdated by a new head turns its pull request back into a draft), [0316](0316-a-brewery-issue-s-label-and-status-comment-name-the-person-s-next-action.md) (the `Next:` line of a batch on tap), [0227](0227-a-later-round-renders-the-pull-request-s-body-again-unless-someone-edited-it.md) ("The draft state is not changed": the engine turns a pull request back into a draft when a new head outdates its brief), and [0197](0197-acceptance-ships-as-a-default-diff-lens-and-nip-tastes-through-it-beside-correctness.md), [0306](0306-nip-tastes-through-the-security-lens-beside-correctness-and-acceptance.md) and [0343](0343-nip-tastes-through-design-conformance-as-a-fourth-advisory-lens.md) (a Taster's `changes` no longer opens the pull request as a draft: every one opens as a draft)

## Context
A batch on tap with an open pull request that had no current merge brief said two things in one status comment (#940): `Next: review and merge <url>.` (ADR 0316, for every open pull request) and `<url> is not ready to merge yet: no merge brief` (ADR 0229, ADR 0272).
The demo showed both.

Three facts shaped the decision.
- **Readiness had two meanings.** A pull request opened ready when every Taster approved and the body had its How it works (ADR 0167), and Foedrum's own word for ready to merge is the merge brief, posted once every check on the head passed (ADR 0225). Nothing marked a pull request ready later: the draft state was sent once, in the open, and never again (ADR 0227, ADR 0345).
- **A brief can stay away for good.** It comes only for the pull request `openOf` gives, and once someone else pushed to its branch, `openOf` gives none (ADR 0198, ADR 0229).
- **Only `foedrum serve` reads checks.** Its intake records them (ADR 0213); `foedrum brew` has no intake, so under it alone no brief comes.

The maintainer decided (2026-11-08): readiness is GitHub's own draft state, and the label `foedrum:awaiting-merge` keeps its meaning, "we wait for the merge", not "ready to merge".

## Decision

### A draft until its brief
- **Every brewed pull request opens as a draft.** `pullRequestText` gives `draft: true` whatever the Tasters said; `opensAsDraft` is removed.
  The body's line that said why it was a draft or ready is one fixed line, `Opens as a draft: Foedrum marks it ready for review once its merge brief is posted.`, after the lines of what a skip went past (ADR 0345) and the line of a Taster that asks for changes, both kept.
  A repository that cannot have drafts still opens it ready (ADR 0167).
- **Ready for review exactly while its merge brief is current** (`briefNow`, ADR 0225, ADR 0229), one rule for the mark, the `Next:` line and the pull request's line. Each mark of the latest brief `n` is an effect of its own, the `k`th to ready `[batch, "brief.<n>.ready.<k>"]` and the `k`th to a draft `[batch, "brief.<n>.draft.<k>"]`; the pull request is ready while brief `n` has one more mark to ready than to a draft.
  - **Marked ready** when brief `n` is current and its marks are even: found when the pull request is no draft, applied with GraphQL's `markPullRequestReadyForReview` by the pull request's node id, which REST's `GET pulls/{n}` answers with `draft`. Its ledger result is `{ ready: true }` (`MergeBriefReady`).
  - **Turned back into a draft** when brief `n` is no longer current after a mark to ready, and the pull request is still the batch's (`openOf`): a new head outdated it (ADR 0229), or a re-run of its head, or a base check of it, no longer passes. It is found when the pull request is a draft, applied with GraphQL's `convertPullRequestToDraft`, and its result is `{ draft: true }`, or `{ draftless: true }` when GitHub answers that the repository does not support draft pull requests (`MergeBriefDraft`). When the same head passes again with the same checks, brief `n` is current again and its next mark makes it ready; with other checks, the next brief posts and marks it (ADR 0225).
  - A later brief of the same head (a re-run, ADR 0229) keeps the pull request ready: the earlier brief is no longer the latest, and the later one is marked ready.
  - A brief of the same head that no longer holds stays shown: ADR 0229 hides only a brief whose head moved. The pull request's line says so: `is not ready to merge yet: its merge brief <link> no longer holds on <sha>`, in place of `no merge brief` (`briefLine`, `src/engine/merge-brief.ts`).
  - **Once someone else pushed to it, Foedrum changes nothing on it**: no draft, no ready. The person reviews and merges it without a brief, or marks it ready.
- **Both effects are their own source** (`readyForReviewEffects`, `src/engine/ready-for-review.ts`), beside the brief's, so a kill between a post and its mark marks once, and the brief's own keys stay as they were. A re-run that goes back and forth marks the pull request back and forth with it, so GitHub always says what Foedrum says. GitHub's side is `githubPullRequestDrafts` (`src/github/pull-requests.ts`).

### The Next line follows the brief
- **One clause per open pull request, on the one `Next:` line** (`pullRequestsNext`, `src/engine/status-comment.ts`), joined with `; `:
  - its brief current (ready for review): `review and merge <url>`, the ones with a brief first and together;
  - the pull request the batch follows (`openOf`) without a current brief: ``wait for <url>'s merge brief: it comes once `foedrum serve` reads its checks passed on `<sha>` ``. It names `foedrum serve`, since under `foedrum brew` alone no brief comes. A failing check holds the brief too, and the pull request's line says which; a recipe's route sends the batch back for it (ADR 0219).
  - any other open one: `Foedrum follows <url> no more: review and merge it without a merge brief, or mark it ready yourself`. It names no cause: someone else pushed to it, or the batch's own latest push pushed nothing (`empty`, `refused`), which `openOf` passes over too.
- **The label does not change.** `foedrum:awaiting-merge` still names every batch on tap with an open pull request (ADR 0316): it waits for the merge, whether the pull request is ready or a draft.

### What changes for a person
- **An advisory Taster's `changes` no longer holds a pull request a draft.** Its brief marks it ready once its checks pass, and the brief and the body list those findings. So does a body with no How it works, which the body says.
- **A pull request is ready for review exactly while its merge brief is current**, in a repository that can have drafts.

## Migration
None in a Brewery's files: no recipe or configuration sets the draft state.
On the first pass after the upgrade:
- **An open pull request whose brief is current** is marked ready once, or found ready (one that opened ready when every Taster approved).
- **An open pull request without a current brief** keeps its draft state: one that opened ready stays ready until a brief marks it and is no longer current, since only a brief's mark to ready can be followed by one to a draft.
- **The status comment of a batch on tap with an open pull request without a current brief** gets one revision, for its `Next:` line; one whose brief is current shows the same text and gets none. An ended batch's comment is never written again (ADR 0345, #920).
- **A pull request's body** keeps its old draft line until a later round renders it again (ADR 0227).

## Consequences
- The status comment never tells a person to merge a pull request Foedrum says is not ready, nor to wait for a brief that will not come.
- Two more effects per brief, at most: one GraphQL mutation each, after two REST reads of the pull request, the effect's `find` and the read of its node id, each conditional and free of the rate limit when nothing changed ([ADR 0052](0052-github-reads-rate-limit-pauses-and-the-polling-interval.md)).
- A pull request goes back to a draft for each fix round that moves its head after a brief, and while a re-run of its head runs or fails, and GitHub notifies its reviewers of each change.
- GitHub's answer to `convertPullRequestToDraft` in a repository without drafts is matched by its message, as the open's 422 is; it was not tried against GitHub.

## Alternatives considered
- **A label of its own while no brief is current** (`foedrum:awaiting-brief`): a second meaning for the label when GitHub's draft state already says it (the maintainer, 2026-11-08).
- **Leave a pull request ready when its brief is hidden**: a ready pull request with no current brief is the disagreement #940 removes.
- **Ready while its latest brief is not outdated**, so a re-run of the same head leaves it ready: the pull request's line would then say its checks failed and that it is ready to merge, side by side (the consultant, 2026-11-08).
- **A `Next:` clause for failing checks** (`see to <url>'s failed checks`): the pull request's line names the failing check, and a recipe's route sends the batch back on the next tick; the consultant kept three clauses.
- **Mark ready in the brief's own effect**: a kill between the post and the mark would leave a brief posted on a draft with nothing that marks it, and the brief's keys would change for every existing test of it.
