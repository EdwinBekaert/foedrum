# 0387. Serve opens a rack issue every 4 weeks

Date: 2026-11-12 · Status: Accepted · Amends [0383](0383-rack-archives-finished-batches-and-deletes-old-archive-folders-and-temporary-files.md) (rack is started by an issue serve opens too, on a schedule, and its issue is closed once it ran), [0063](0063-foedrum-serve-its-configuration-and-wiring.md) (serve's loop reads the rack issues beside its ticks), [0296](0296-a-target-repository-s-pull-request-names-no-brewery-issue-and-the-engine-closes-it.md) (the engine also closes a finished rack batch's issue) and [0033](0033-chaos-tests-effects-found-by-key-and-leases-at-start.md) (the rack issue is an external side effect opened outside the ledger, found again by its label)

## Context
Rack, the Brewery's cleanup, runs when a Brewery issue labelled `recipe:rack` is ordered and a person gives their go (ADR 0383).
Nothing opened that issue by itself, so a Brewery was cleaned only when someone remembered to (#1012).
ADR 0383 left a schedule out.
The maintainer decided on 2026-11-12: `foedrum serve` opens one every 4 weeks, with no stored date, no setting, and no new event, store record, command, label or recipe.

## Decision
- Where the Brewery has a recipe named `rack`, `foedrum serve` opens a Brewery issue labelled `recipe:rack` when every one is closed and the newest was opened 28 days ago or more (`rackDue`, `src/engine/rack-schedule.ts`).
- While there is none yet, it opens the first only once the oldest batch in the store was ordered 28 days ago or more (its `orderedAt`); with no batch at all, none. A new Brewery's first cleanup so comes 4 weeks after its first order, when there is something to clean, never at serve's first start (decided by the maintainer on 2026-11-12, after CI showed the ladder demo's issue numbers shift).
  A Brewery without a rack recipe gets none: there is nothing for the issue to start.
- Serve keeps no date.
  At its start, and then at most once an hour, it reads the Brewery's issues labelled `recipe:rack`, open or closed, every page, through the conditional reads (ADR 0052), so an unchanged read costs no rate limit (`githubRackIssues`, `src/github/rack-issues.ts`).
  The read runs beside the ticks, never awaited by one, as the intake pass is (ADR 0068), and not while a rate-limit pause holds; a stop waits for it as for the pass.
- The issue is titled `Rack: clean up the Brewery`.
  Its body says Foedrum opens it every 4 weeks, names what the Brewery's own rack steps do with their ages in words (`archives the finished batches`, `deletes archive folders older than 180 days`, `deletes temporary files in .foedrum/tmp/ older than 2 days` with the default `rack.jsonc`), that nothing runs until `foedrum approve <n>`, and that closing the issue skips this cleanup.
- The intake orders it as any labelled Brewery issue, and rack waits at its gate for a person's go (ADR 0383).
- A read or an open that fails opens nothing and says one line, `the rack check failed: …`; the next read, an hour later, tries again.
- The 4 weeks are fixed. A setting comes only when someone needs another period.
- Only serve opens it; `foedrum brew` does not.
- Once rack ran to its end, the engine closes its Brewery issue, so the next read finds every rack issue closed.
  The close is due when the batch's recipe is `rack`, its lane is on tap with no pull requests, and it is the issue's latest batch; it goes through the close's ledger effects `close.comment` and `close.issue` (ADR 0296), with the comment `Rack ran; Foedrum closes this cleanup.` (`dueClose`, `src/engine/brewery-closes.ts`).
  Without it nothing would close the issue, and serve would open no second one: a batch on tap with no pull request closed nothing before.
  Another recipe that ends on tap with no pull request still leaves its issue open.

### Why no ledger
- The ledger keys an effect by its batch, and its record is an `effect.applied` event; a rack issue belongs to no batch, and a new key or event was ruled out.
- It is not needed: the issue on GitHub is the record.
  Once opened it is open and labelled `recipe:rack`, so every later read finds it and opens no second one, whatever crashed after the open.
- Two serves on one Brewery work root cannot both read and open: the driver lock `cellar` refuses the second before its loop (ADR 0063).
  Two serves on two machines for one Brewery are guarded for nothing else either, and nothing is built for them here.

## Consequences
- **What an existing Brewery must do: nothing.** Foedrum has no release. A Brewery with the default `rack` gets its first rack issue once its oldest batch in the store is 4 weeks old.
- The intake orders a Brewery issue only when its author is in `users` (ADR 0068). Serve opens it as gh's login, which `foedrum init` puts in `users`; a Brewery that took that login out gets an issue every 4 weeks that the intake never orders. The design page says so; nothing is built against it.
- A rack batch already on tap when this ships gets the close at the driver's first tick after it: an open issue gets the comment and is closed, and one a person closed is only recorded. Foedrum has no release, so no Brewery has such a batch from before.
- Rack's archive waits for that close as for any close still due (ADR 0383), and takes the rack batch once its issue is closed, at the next rack run.
- A person who closes the issue skips one cleanup; the next opens 4 weeks after the closed one was opened, not after it was closed.
- A rack issue someone else opened counts as the newest as well, and so does an open one: serve opens none beside it.

## Alternatives considered
- **A date in the store or a file.** The issue's own creation time says the same, and survives a store rebuilt from the state branch.
- **Through the ledger, keyed by the date.** See above: a new key or event for nothing GitHub does not already hold.
- **The first rack issue at serve's first start.** A new Brewery would get a cleanup with nothing to clean, and every demo and walkthrough an issue it does not show.
- **A read on every tick.** Every 5 s for a 4-week period; once an hour is enough.
