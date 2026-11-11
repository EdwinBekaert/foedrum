# 0373. A label-approved order's brewers read every comment made before its approval

Date: 2026-11-11 · Status: Accepted · Amends [0333](0333-a-brewer-s-order-holds-the-maintainers-comments.md) (which comments of a claimed issue a brewer hears, and what the input limit counts), [0359](0359-the-intake-takes-an-issue-only-when-someone-in-users-added-its-labels.md) (what the label approves), [0368](0368-an-issue-changed-after-its-approval-asks-the-engineer-whether-to-continue.md) (an approval also says which comments reach the brewers) and [0338](0338-a-resumed-session-hears-the-comments-made-since-it-last-read-them.md) (a resumed session is told only approved comments)

## Context
A brewer's `order` held the issue's body and the comments of its repository's maintainers, by `authorAssociation` ([ADR 0333](0333-a-brewer-s-order-holds-the-maintainers-comments.md)).
Since [ADR 0359](0359-the-intake-takes-an-issue-only-when-someone-in-users-added-its-labels.md) a target repository's issue is approved by its intake label when someone in `users` set it, whoever opened the issue.
A community member's issue can be brewed, but their own comments on it, such as answers to the maintainers' questions, were dropped: the brewers built from half the conversation the person approved.
And a maintainer's comment made after the label reached the brewers, though nobody approved it.

[ADR 0368](0368-an-issue-changed-after-its-approval-asks-the-engineer-whether-to-continue.md) gave the approval a time, and asks the engineer about anything changed after it.
The maintainer decided on 2026-11-10, recorded on #976: **the label approves the issue as it stands,** its title, its body and every comment present when it was set, whoever wrote them.

## Decision

### Which comments reach a claimed order's brewers
- **Every comment on the claimed target issue but Foedrum's own that its approval approved, whoever wrote it.** This replaces ADR 0333's association rule for that issue.
- **A comment counts by its last change, `updated_at`,** as ADR 0368's check counts it: an old comment edited after the approval stays out until a continue approves it, and the check asks about that edit before any attempt reads the issue.
- **What the approval approved is the exact complement of what ADR 0368's check asks about,** one predicate (`approves` in `src/engine/order-changes.ts`) that `changesSince` negates, so the two can never disagree:
  - for a label or a person's order, a comment last changed **before the approval's second**: GitHub's times are whole seconds, so a change in that second is one the person who approved may not have seen, and the check asks about it;
  - after the engineer's "continue", a comment last changed **up to and with its `upTo`**: the question showed it.
- **An issue with no approval** (`approvedAt` undefined, such as one whose filter has no label any more) **has no comment that reaches the brewers.** Its body still does; the check asks about every change it ever had before any attempt starts.
- **Foedrum's own comments stay out,** as ADR 0333 tells them: the Brewery's login and a last line that is an effect marker.
- **The approval is read as the check reads it, never computed a second way:** the attempt plan's new `approval(batch)` option reads the issue's label events (`githubOrderEvents`, the part of `githubOrderActivity` that reads them) and gives them to `approvedAt`.
  The driver's check result is not handed to the plan: the plan is made by the runner, a separate object, and an approval kept in memory between them would be state outside the event store that a restart loses.
- **A comment made between the check and the plan** is past the approval, so it stays out; the next attempt's check asks about it.
- **Without the `approval` option** (a caller that wires none), a claimed target issue's comments do not reach the brewers: the rule fails closed. The driver's wiring gives it, and `serve-intake.test.ts` tests that through `runServe`.

### What keeps ADR 0333's rule
- **A Brewery issue, the Brewery issue of a claimed order, and a sub-order's issue** keep the association rule: their maintainers' comments, by `OWNER`, `MEMBER` or `COLLABORATOR`.
  No label approves them, ADR 0368 never checks them, so there is no approval time to cut at; the Brewery is its users' own repository (ADR 0359), and a person works on its issue ([ADR 0329](0329-one-number-per-piece-of-work.md)).

### A resumed session
- **The approval first, then [ADR 0338](0338-a-resumed-session-hears-the-comments-made-since-it-last-read-them.md)'s mark:** a resumed session is told only approved comments with an id above the highest it heard on that issue.
  A comment made after the label and then approved by a continue has a higher id than any the session heard, so it is told.
- **What it is told of them** no longer says that maintainers made them: "comments made on the order's issue since this session last read them, each source saying who wrote it" (`goOn` in `src/brewers/attempt-plan.ts`), since a stranger's approved comment is one of them.
- **The edited-comment gap of ADR 0338 stays:** a comment edited after the approval keeps its id, so once a continue approves it a resumed session is not told its new words. A fresh attempt reads it as it now stands.

### What it costs
Counted from the code, per attempt of a claimed order whose brewer reads the order:
- **the label events,** read again by the plan: one conditional REST request per started 100 events. The driver's check read the same URLs moments before in the same tick, so each answers 304, which does not count against the primary limit ([ADR 0052](0052-github-reads-rate-limit-pauses-and-the-polling-interval.md));
- **no GraphQL point:** the approval needs no edit of the body;
- **the comments:** the read ADR 0333 already makes, by the same URL as the check's, so 304s too.

## Consequences
- **A community member's answers reach the brewers** when they were made before a person in `users` labelled the issue, as part of what that person approved.
- **A maintainer's comment made after the label no longer reaches the brewers until the engineer continues**, nor does anyone else's; ADR 0368's check already stops the batch and asks.
- **The 1 MiB input limit now counts strangers' comments made before the approval** (ADR 0333 said only maintainers' count, so a stranger could not fill it). A stranger can fill it only before a person approved the issue as it stood, and the attempt then fails visibly, naming the limit; after the approval nothing they write counts.
- **The Brewery:** no file changes, and no event changes.
  After the upgrade, a label-approved order's brewers read every comment up to its approval, whoever wrote it, and no longer a maintainer's comment made after it until the engineer continues. A running batch's later fresh attempts see this once the driver restarts on this version.
