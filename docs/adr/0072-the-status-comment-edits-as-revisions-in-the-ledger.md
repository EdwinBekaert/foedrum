# 0072. The status comment: edits as revisions in the ledger, one a minute per order

Date: 2026-10-18 · Status: Accepted · Amends [0033](0033-chaos-tests-effects-found-by-key-and-leases-at-start.md) (an effect that edits what an earlier one made), [0052](0052-github-reads-rate-limit-pauses-and-the-polling-interval.md) (the first GitHub writes beyond the claim marks) and [0068](0068-the-intake-in-foedrum-serve-brewery-orders-and-routing-by-label.md) (serve reads the token's login for every Brewery)

## Context
Architecture §8 gives every order one status comment on its issue, edited in place: the projection a human reads on GitHub without the CLI. #179 brings it to M1 and leaves three questions open:

- **Its identity.** Every external side effect goes through the idempotency ledger and is applied at most once (I4, [ADR 0033](0033-chaos-tests-effects-found-by-key-and-leases-at-start.md)). A comment edited many times is not one effect, and a key that would let the same edit run twice breaks I4. And someone may delete the comment by hand.
- **When it is edited, and how often.** GitHub's secondary limits allow about 80 requests that make content a minute and 500 an hour for a token; an edit is such a request. The driver applies effects every tick (5 s, [ADR 0063](0063-foedrum-serve-its-configuration-and-wiring.md)).
- **What M1's comment shows.** §8 names a Mermaid diagram and the cost; #179 leaves them for later.

What exists: the driver asks a source of effects which keys the recorded events call for (`DriverEffects.due`), drops those in the ledger, and applies the rest through `applyEffect` under the batch's lease, each found by its key on the target first. The claim marks of a target issue are such a source ([ADR 0050](0050-the-intake-of-target-repository-issues.md)). The intake orders a Brewery issue only while it has no batch (ADR 0068), so in M1 an order has one batch.

## Decision

### Which issues
- **Every batch of a Brewery issue gets one status comment on that issue**, an order's or a sub-order's: the batch the issue was ordered as. Since an issue is ordered once, that is one comment per order.
- A claimed target-repository issue keeps its claim comments (ADR 0050) and gets no status comment in M1: it would put the text brewers wrote, assumptions and questions, on someone else's repository with every step. A later issue can add it with a setting per target.

### Identity: one effect per revision, the comment found by its id
- Each edit is an effect of its own, keyed by the batch: `[batchId, "status.<n>"]`, with revisions numbered from 1. Revision 1 makes the comment; every later one edits it. Each is applied at most once, so I4 holds per edit.
- What a revision records in the ledger is `{ comment, digest }`: the comment's id, and the first 16 hex digits of the SHA-256 of the text it showed. Not the text: the ledger lives on the state branch for good.
- **Due** (`statusDue`, pure): the batch's text is rendered from the folded state; a revision is due when no revision is recorded yet, or the latest recorded one's digest is not the text's. The next revision is due, numbered one past the latest. So an engine killed between applying and recording a revision finds the same one due again with the same key.
- **The comment** ends with the marker of its revision's key (`<!-- foedrum:<key> -->`, as the claim comment does). Only a comment by the Brewery's own login counts (ADR 0033): keys are predictable.
- **Find**: a revision after the first reads the previous revision's comment by its id (conditional, ADR 0052); when it is the Brewery's and ends with this revision's marker, the revision is found. When that comment is gone, or for revision 1, the issue's comments are searched for a comment of the Brewery's that ends with this revision's marker: a run killed after making the comment again finds it there.
- **Apply**: revision 1 makes the comment. A later one edits the previous revision's comment; when GitHub answers 404 (the comment was deleted by hand), it makes the comment again, and records the new id. **So a comment deleted by hand is found missing at the next edit and made again then.** Nothing watches the comment between edits, which would cost a request per order every tick; a comment deleted after the batch ended stays deleted, since no edit follows. An edit made by hand is overwritten by the next revision.

### When: at the driver's passes, at most one edit a minute per order
- The text holds the lane, the steps and what they recorded, so it changes at step boundaries and lane changes, and at nothing else: no timestamp of a reminder or deadline is in it, so a reminder edits nothing. A driver's effect pass applies at most one revision per batch, the latest text: states in between are never shown.
- **An order is edited at most once a minute** (60 s): a revision is not due within a minute of the last revision this driver applied for the batch. The first revision, and a revision whose batch ended (on tap or cancelled), are due at once: the comment shows up as soon as the batch is ordered, the batch never ends with its last state unshown, and the driver never holds an ended batch's lease for a wait. The last edit's time is kept in memory: a driver that starts again may edit at once.
- A minute per order keeps a Brewery far below GitHub's limits for any `concurrency` M1 can run, since a batch has a few step boundaries, not a stream of them. The client's pause ([ADR 0052](0052-github-reads-rate-limit-pauses-and-the-polling-interval.md)) holds every edit when GitHub refuses one: it fails, and the next pass after the pause applies the latest text.
- The status comments and the claim effects are two sources the driver applies together (`combineEffects`): each key goes back to the source that gave it.

### What M1's comment shows
- The batch and its lane: Ordered, Brewing, Conditioning ⏳ with what it waits for, Stuck 🔔 with its reason and the options that get it moving, On tap, Cancelled.
- The recipe, how it was chosen (label, router, or who chose it), and its steps in order (the recipe's `steps`), each marked: done, skipped, the current one with its attempt, failed, or not reached. Before routing it says that no recipe is chosen yet.
- The assumptions from each step's latest out doc that succeeded.
- The pull requests once the batch is on tap.
- Not yet: the Mermaid diagram (M2) and the cost.
- Everything a brewer or an issue wrote (summaries, questions, assumptions, reasons) is untrusted: each is one line with Markdown and HTML characters escaped and `@` written as an entity, cut to 200 characters after escaping (between characters, so no escape is cut in half), so it mentions no one and cannot fake a marker. A pull request URL is written as an autolink of its normalized form (`<${new URL(url).href}>`), since its schema keeps the text it was given. At most 10 assumptions a step, 10 questions and 10 options a question are shown, and the rest are counted, so the text stays far below GitHub's 65,536 characters; a text past 60,000 characters all the same (a recipe of very many steps) is cut at a line, with a note.

## Consequences
- An order's issue shows one comment that follows its batch from Ordered to on tap, made and edited only by the driver that holds the batch.
- `Recipe` gains `steps`, the step ids in order, so the comment lists the steps a batch has not reached yet.
- `foedrum serve` reads the token's login at its start for every Brewery now, not only one with a target intake: the status comments find only the Brewery's own comments.
- Every edit is an `effect.applied` event on the state branch: a batch adds one per step boundary or lane change, at most one a minute.
- The tests render plain folded states and apply the effects with a fake of the comments host; none reaches GitHub (ADR 0021).

## Alternatives considered
- **One effect for the comment and edits outside the ledger:** fewer events, but an edit is an external side effect like any other, and outside the ledger nothing would tell a restarted engine which state the comment shows.
- **A key per rendered text (`status.<digest>`):** no counter, but a text that comes back (Brewing at a step, Stuck, Brewing at the same step again) would find its key in the ledger and never be shown again.
- **Search the issue's comments for the marker on every revision:** no id to keep, but a page of comments read per edit, and changed by the edit itself, so never a 304.
- **Check the comment on every pass and make it again at once when deleted:** a request per live order every tick, for a case a human caused and the next edit repairs.
- **Edit at every pass the text changed:** the most current, but up to 12 edits a minute per order while a batch moves quickly, which a few busy orders would take to GitHub's secondary limit.
- **A status comment on claimed target issues too:** one place to read for both kinds of order, but model-written text on another owner's repository at every step; left to a setting per target.
