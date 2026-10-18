# 0068. The intake in `foedrum serve`: Brewery orders, routing by label, and relabelled issues

Date: 2026-10-17 · Status: Accepted · Amends [0008](0008-polling-intake.md) (which Brewery issues are orders), [0032](0032-routing-deadline-for-ordered-batches.md) (who routes, and the routing interval), [0050](0050-the-intake-of-target-repository-issues.md) (the intake pass and its capacity setting), [0052](0052-github-reads-rate-limit-pauses-and-the-polling-interval.md) (the listing's filter, the cache's bound and the polling setting) and [0063](0063-foedrum-serve-its-configuration-and-wiring.md) (what `serve` runs besides the driver) · Amended by [0072](0072-the-status-comment-edits-as-revisions-in-the-ledger.md)

## Context
[ADR 0050](0050-the-intake-of-target-repository-issues.md) gave the intake a pass that claims and orders target-repository issues, and [ADR 0052](0052-github-reads-rate-limit-pauses-and-the-polling-interval.md) its GitHub reads. [ADR 0063](0063-foedrum-serve-its-configuration-and-wiring.md) made `foedrum serve` brew the batches its store has, but nothing in it polls, orders or routes. #145 wires that, and #103 left three questions for it:

- **Which Brewery issues are orders, and how they are routed.** ADR 0008 polls the Brewery; architecture §6 routes by a `recipe:<name>` label first and a router call otherwise. The router (the Innkeeper) is milestone M2's.
- **Relabelled issues.** How a changed or relabelled issue maps onto a batch that exists.
- **The routing interval.** Whether the one-hour routing deadline of ADR 0032 becomes configurable per Brewery here, or later with the reminder interval.

Two review inputs on #145 also belong here. The listing of a target repository read every open issue and filtered locally, so a repository with thousands of open issues cost hundreds of requests per poll and could pass `maxPages`. And the ETag cache was bounded by entries only, up to 1 GiB of untrusted bodies in the worst case.

## Decision

### Which Brewery issues are orders
An issue of the Brewery is ordered by the intake when all of these hold (`isBreweryOrder`, `src/engine/intake.ts`):
- it is open and not a pull request;
- one of the Brewery's allow-listed users opened it (`users` in `foedrum.jsonc`, architecture §10);
- it carries a `recipe:<name>` label. In M1 the label is how a person asks for a batch: without a router there is nothing else to choose its recipe, and an unlabelled issue may be a note, a question or a sub-order to be. When the router comes (M2), a Brewery setting can widen this to issues without the label;
- it has no batch in this Brewery, in any lane, and it is not a sub-order (sub-orders are ordered by their decomposition, ADR 0013). A sub-order is known by its recorded `order.decomposed`, so the decomposition (M2) must record it before its issues carry a `recipe:` label; until then the intake would take such an issue for an order of its own, and the fold would refuse the decomposition. As for a target issue (ADR 0043), a batch that was cancelled or whose pull request was closed is never brewed again by itself; a person orders it again with `foedrum order` (#186).

Its batch is `<issue>-1` (`nextBatchId`). Brewery issues are read with the conditional listing of ADR 0052, oldest first and unfiltered on GitHub, since a label prefix cannot be asked for there.

A pass orders **Brewery issues first, then target-repository issues**, both oldest first and both within the free capacity (ADR 0050): the Brewery's own issues are its owners' requests, and a target repository's are a shared queue that other Breweries can serve.

### Routing by label, in the same pass
After it orders, the pass routes **every Ordered batch** whose issue it read in this pass, whoever ordered it: its own orders of this pass, orders of a pass that was killed before it routed, sub-orders, and batches a `retry` sent back to Ordered (ADR 0032).
- The batch is routed with `route` (`source: 'label'`, reason `the label recipe:<name>`) when its issue carries **exactly one** `recipe:<name>` label and the Brewery has a recipe of that name.
- Two such labels, or a name the Brewery has no recipe of: the batch is not routed, and the pass reports it once per batch and reason, not every minute (`unrouted`). No such label: the batch is not routed either, and nothing is reported, since that is how a claimed issue waits for a person or, later, the router. Either way it stays Ordered until its routing deadline, then the supervisor makes it Stuck on routing (ADR 0032), with its reminder, where a person chooses a recipe (`recipe`) or fixes the label and retries.
- An issue the pass did not read (its repository could not be listed, the issue was closed, or it no longer passes the repository's filter) leaves its batch waiting the same way.
- Routing takes no capacity: an Ordered batch already holds its place.
- **Who chooses the recipe of a claimed issue.** Anyone who can label issues in a target repository can add a `recipe:` label, not only the Brewery's owners. That is accepted: such a person already decides which issues pass the filter, the issue's author must still be allow-listed (ADR 0043), and a label can only choose among the Brewery's own recipes, each brewing within the permission ceiling and the repository's tools that the Brewery's owners set. It never widens what a brewer may do.

### Relabelled issues
**Recommendation, decided: a batch never follows its issue's labels once it is routed.** The labels count only while a batch is Ordered: at its first routing, and after a retry from Stuck on routing. Removing or changing a `recipe:` label, or a target repository's filter labels, after that changes nothing; to brew with another recipe a person uses `recipe` while the batch is Stuck, or cancels it and orders it again (#186). A label added to an issue whose batch ended orders nothing.

The reason is ADR 0050's for pull request ends: what a batch does follows from recorded events, never from what GitHub answers at the moment. A batch that switched recipes whenever someone edited a label would brew differently on a restart that read the labels a second later, and a label edit by anyone with triage access would throw away an attempt underway. A closed issue does not cancel its batch either; closing, like the status comment, comes with the GitHub commands of the command layer.

### The routing interval
**Recommendation, decided: not configurable yet; one hour, as ADR 0032 set.** When it becomes a setting, it does so together with the reminder interval, in one Brewery setting that every writer of the store reads. A `retry` from the terminal sets a new `routeBy` with its own command log, so a setting that only `serve` read would give the same command two deadlines depending on where it was typed, and the terminal does not read `foedrum.jsonc` yet (#186 brings it there). Since the intake routes in the pass that orders, the deadline now only measures failures (no label, an unknown recipe, an intake that is down), for which an hour is a fair wait before a person is told.

### The intake in `serve`
- `foedrum.jsonc` gains **`users`** (the allow-listed GitHub logins), **`concurrency`** (the batches that may be Ordered or Brewing at once, the intake's capacity; 1 to 20, default 1) and **`pollEvery`** (a duration from `30s` to `1h`, default `60s`, ADR 0052's interval). `serve` refuses to start without a user, since nothing could be ordered.
- **The intake runs beside the driver's ticks, never inside one.** `serve`'s loop starts a pass when `pollEvery` has passed since the last one started and none is underway, and goes on ticking every 5 s while it runs. A slow pass, held to its deadline of at most half the batch lease (ADR 0050), never holds off the heartbeat or the end of an attempt. On a stop, `serve` waits for the pass underway, which its deadline bounds, before it closes the store.
- **During a rate-limit pause** (`GitHubRateLimited` in a pass's report), `serve` starts no pass until its `until` (ADR 0052). The GitHub client's pause runs on `serve`'s clock, the one that decides when to poll.
- With a repository that has an intake, or a claimed batch in the store (an intake removed from the config leaves its batches' releases due), `serve` reads the token's login once at its start (`GET /user`), for the claims and the marks, and gives the driver the claim marks and releases as its effects (`claimEffects` over `githubIssueMarks` and `githubClaimHost`, ADR 0050).
- Every notice of the intake is one line of `serve`'s output: ordered, routed, not routed and why, taken by another Brewery, refused, failed.

### The listing and the cache
- A target repository's listing asks GitHub for its filter's labels (`labels=` with all of them; `TargetTracker.issues(repo, filter, signal)`), so a repository with 6,000 open issues and 3 candidates is one page. The filter is still applied again to every issue, since the listing is untrusted input. A label with a comma cannot be named in `labels=`, so a filter with one lists every open issue as before; the milestone stays local, since GitHub's `milestone` parameter takes a number, not the title the filter names.
- The cache of `createGitHubReads` is bounded by bytes as well as by entries: 64 MiB of answers at most, least recently used out first, counted from the length of each answer the client read (`GitHubAnswer.bytes`). One `pages` read collects at most 32 MiB, and more fails the read, as more than `maxPages` does.

## Consequences
- A Brewery with a labelled Brewery issue and one target repository with an intake orders and routes both through `serve`, against a fake GitHub, and applies the claim marks; a slow GitHub runs a pass to its deadline while the batch leases stay alive.
- An issue without a `recipe:` label is not an order in M1. A claimed target issue without one goes Stuck on routing after an hour; the Brewery's owner picks its recipe there, until the router does.
- The worst case of the reads' memory is 64 MiB of cache plus one list of 32 MiB, instead of about 1 GiB.
- `foedrum.jsonc` gains `users`, `concurrency` and `pollEvery`; existing configs stay valid, and `serve` now refuses one without `users`.
- `TargetTracker.issues` takes the filter.
- The chaos case of #107 is here: the intake killed between an order and its route (`test/chaos/intake.test.ts`). The next pass routes the batch, the issue is never ordered twice, and an intake that never comes back leaves the batch Stuck on routing within one supervisor tick after its deadline.
- `foedrum order` is #186.

## Alternatives considered
- **Order every open Brewery issue of an allow-listed user, labelled or not:** what the glossary's "an issue in the Brewery" says, but without a router every unlabelled issue would go Stuck on routing an hour later, and a Brewery's notes and questions would become batches.
- **A configured label (`foedrum:order`) for Brewery orders, as target repositories have a filter:** one more setting for what the `recipe:` label already says in M1. The router's setting can add it.
- **Route only the batches the pass ordered itself:** simpler, but an order whose pass was killed before its route, a sub-order and a retried batch would all wait for their deadline. It is one of the defects the chaos case was shown red on.
- **Follow relabels:** see above; the lane would depend on GitHub's answer of the moment.
- **Run the pass inside the driver's tick, awaited:** one sequence of writes, but a pass up to its deadline would hold off the next tick, the attempts' ends and the supervisor for minutes. Writers already share the store through the command log (ADR 0044).
- **A routing interval of `serve` only:** see above; a retry would get two deadlines.
- **Filter the milestone on GitHub too:** one more conditional read to map the title to its number, for a filter that already narrows the listing by label.
