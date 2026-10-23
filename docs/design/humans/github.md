# On GitHub

On GitHub, for the autonomous driver and asynchronous teammates:

- One **status comment** per order, edited in place: recipe (as a Mermaid diagram with the current step highlighted), steps, state, assumptions brewers made, cost.
  In M1 every batch of a Brewery order has one, without the diagram and the cost: the batch and its lane (Stuck with its reason and options, Conditioning with what it waits for), the recipe and its steps with the current one marked, the assumptions from the out docs, and the pull requests once on tap, every text a brewer wrote escaped to one line, and left out for a fixed line naming its step when it looks like a secret, a commit the state records for the batch excepted ([ADR 0088](../../adr/0088-out-doc-text-that-looks-like-a-secret-is-left-out-of-the-pull-request-and-the-status-comment.md)) (`renderStatus`, `src/engine/status-comment.ts`).
  Each edit is a revision in the ledger, `[batchId, "status.<n>"]`, due when the rendered text's digest differs from the latest revision's; it edits the previous revision's comment by its id, and makes the comment again when that was deleted by hand.
  An order is edited at most once a minute, its first comment and the edit to on tap or cancelled at once ([ADR 0072](../../adr/0072-the-status-comment-edits-as-revisions-in-the-ledger.md)).
  A claimed target issue keeps its claim comments, and neither it nor the Brewery issue that is its order gets a status comment yet ([ADR 0144](../../adr/0144-a-claimed-target-issue-gets-a-brewery-issue-that-is-its-order.md)).
- A **GitHub Projects board** with one column per lane serves as the kanban view until the Brewhouse dashboard (M6).
- **Labels** mirror lanes: `foedrum:brewing`, `foedrum:stuck`, `foedrum:on-tap`.
  A claimed target-repository issue also carries `foedrum:claimed` until its claim is released ([target-repository issues](../intake/target-issues.md)).
- **Commands** in comments, from allow-listed users only, processed exactly once (the comment id is the idempotency key) and acknowledged with a reaction: 👀 received, 🚀 done, 😕 rejected with the reason in the status comment.
