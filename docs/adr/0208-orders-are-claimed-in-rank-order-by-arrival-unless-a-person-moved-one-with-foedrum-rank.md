# 0208. Orders are claimed in rank order: by arrival, unless a person moved one with `foedrum rank`

Date: 2026-10-26 · Status: Accepted · Amends [0068](0068-the-intake-in-foedrum-serve-brewery-orders-and-routing-by-label.md) (the order of a pass: Brewery issues first, then each repository's), [0043](0043-target-repository-issues-as-a-work-queue-claimed-by-a-ref.md) (the order a pass claims in), [0050](0050-the-intake-of-target-repository-issues.md) (`claimCandidates` and its `ClaimPass` give way to the pass's walk of its queue) and [0030](0030-only-commands-that-change-state-are-recorded.md) (one more recorded command)

## Context
A pass of the intake orders the Brewery's own issues first, by number, then claims each target repository's candidates in the order `foedrum.jsonc` lists the repositories, each by number, within the free capacity ([ADR 0068](0068-the-intake-in-foedrum-serve-brewery-orders-and-routing-by-label.md)).
So an issue opened a week ago in the second repository waits behind one opened a minute ago in the first, and a person who needs one issue done next has no way to say so but to unlabel the others.
#239 asks for a scheduler; the maintainer settled its first part on 2026-10-25: orders rank in the order they came in, `foedrum rank '#xyz' <n>` moves one, and `foedrum rank '#xyz' first` marks it "finish first", recorded with who and why ([ADR 0030](0030-only-commands-that-change-state-are-recorded.md)).
Once the Innkeeper plans (#227), its planning session sets ranks through the same command; the board (#240) shows them.
The ready set of sub-orders (#531) and the limits (#532) are the next parts, not this record.

## Decision

### What is ranked
- Ranking applies to the **queue**: the issues the intake would order or claim now and has not, in the Brewery and in every repository with an intake.
  A Brewery issue is in it while it passes `isBreweryOrder` (open, labelled `recipe:<name>`, opened by an allow-listed user, no batch here in any lane, not a sub-order, not a claimed issue's order), and has no batch until the intake orders it within the free capacity; a target issue is in it while it passes `isCandidate`.
- An order that was ordered or claimed has left the queue, and is no longer ranked.

### Arrival
- An order **arrives** when its issue was created on GitHub (`created_at`, which the tracker reads into `TargetIssue.created`), across the Brewery and every target repository.
- Two orders that arrived in the same second go Brewery issue first, then by the order `foedrum.jsonc` lists their repositories, then by number.

### `foedrum rank`
- **`foedrum rank <order> <n>`** moves one order to place `n` of the queue; **`foedrum rank <order> first`** marks it "finish first"; **`foedrum rank <order>`** prints its place in the queue and its rank.
  `<order>` is written as `pause` takes it: `<alias>#<n>` of a target repository, `#<n>` or `<n>` of the Brewery.
- `rank` reads the queue when it is given, as a pass does, through gh's own login ([ADR 0073](0073-github-only-through-gh-s-own-login.md)): the Brewery's open issues, each intake repository's, and the login (`GET /user`) that tells whether an assigned issue is the Brewery's own.
- **A place is kept as a relative place, not as an index.** `rank <order> <n>` gives the order the arrival of the order now at place `n`, and puts it ahead of it; past the end of the queue, the rank's own time, behind every order listed now.
  So the order moves up as the orders ahead of it are ordered, taken or closed, and an order that arrives later goes behind it; an older issue that passes the filter only later (a label added) goes where its arrival puts it.
  The places count only the orders without the mark: a marked order is ahead of every one of them.
- **`first`** puts the order ahead of every order without the mark; the marked ones go by when they were marked.
- **A tie orders the ranked orders that share an arrival**, the lower ahead, and they all go ahead of the unranked ones of that arrival.
  `rank <order> <n>` chooses it so the order goes just ahead of the order at place `n` and behind a ranked order of the same arrival ahead of that one: below the tie of the order at `n`, between the two ties, or one above the tie of the ranked order ahead when the order at `n` is unranked.
  So `rank X 1` after `rank Y 1` puts X ahead of Y, and `rank Y 3` after `rank X 2`, with the order at place 3 sharing X's arrival, puts Y between X and it.
  An order ranked next to unranked orders that share an arrival goes ahead of all of them: only a rank carries a tie, so it cannot land between two unranked orders of one arrival.
- **A later rank of the same order replaces the earlier one**, so marking a marked order again moves it behind the other marked ones.
- `rank` is refused with one line for an alias `foedrum.jsonc` does not name, for an order that has a batch in any lane (it has left the queue), for a sub-order (its plan ranks it, part 2), for the Brewery issue that is a claimed issue's order (rank the target issue), and for an order that is not in the queue now (closed, filtered out, opened by someone not allow-listed, assigned to someone else); also when the queue cannot be read.

### The event
- `order.ranked` `{ order, place, by, via, why? }`, with `place` either `{ kind: 'first' }` or `{ kind: 'position', position, arrival, tie }`: `position` is the `n` the person gave, kept for `replay`, and `arrival` and `tie` are what the queue sorts by.
  It names no batch, so it goes to the state branch's top-level log, as a pause does ([ADR 0024](0024-state-branch-layout-outbox-and-divergence.md)).
- The fold keeps the ranks in `State.ranks`, by order (`orderKey`), each with a sequence number that says which rank came later; a restart folds the same ranks.
- The queue's order is one pure function over the listed candidates and `State.ranks` (`rankQueue`, `src/engine/ranks.ts`); the intake and `rank` both call it.

### The intake
- A pass lists the Brewery's issues and, with free capacity, every intake repository's, then orders and claims the candidates of the whole pass **in rank order**, within the free capacity, instead of the Brewery's first and then each repository's.
- A claim another Brewery holds still costs no capacity: the pass goes on to the next candidate.
- A claim the code host fails ends that repository's claims for this pass, as on main, and the other repositories' go on: a failure there is likely a rate limit or lost access, not one bad issue, and the next pass tries again.
- A repository the pass cannot list is left out of this pass's queue, and reported, as before.
- `pause --all` still holds the intake: it orders and claims nothing, whatever the ranks ([ADR 0202](0202-pause-and-continue-hold-an-order-or-the-whole-brewery-at-its-next-convenient-point.md)).

### Where it shows
- `foedrum replay` lists `order.ranked` with who, from where, why and the place.
- `foedrum rank <order>` prints the order's place in the queue as read now, and its rank, and appends nothing, though `rank` is a command that changes state; the board (#240) shows the whole queue later.

### What the next parts add
- **Part 2 (#531):** the ready set of sub-orders, which start in their plan's order within their order's rank; `rank` of an order with sub-orders that are not all done is accepted then, and orders its sub-orders against other orders' (the refusal of an order with a batch is narrowed to that).
- **Part 3 (#532):** the limits on what runs side by side (touches that overlap, a blocker done only when its pull request is merged); a rank orders what the limits let start, and never overrides them.
- `first` stays as recorded here: the mark goes on ranking an order's sub-orders ahead in part 2, and the Innkeeper (#227) sets it through the same command.

## Consequences
- The oldest issue across the Brewery and its target repositories is ordered first, and a person can move one or mark it to finish first, from the terminal or the plugin (`/foedrum:rank`).
- A Brewery's own issues no longer go ahead of an older target issue: the owners' way to say "this first" is `rank`, not where the issue was opened.
- `rank` needs gh's login and the network, as `order` of a target issue does; the other recorded commands do not.
- One event type, one fold field and one pure module; `TargetIssue` gains `created`, and `claimCandidates` gives way to the pass's own walk of its queue.

## Alternatives considered
- **Keep `n` as a fixed index, resolved at each pass.** No read when ranking, but the order stays at place `n` while the orders ahead of it are claimed and others take their places, so with capacity 1 it waits until fewer than `n` orders are left.
- **Resolve `n` at the next pass, recording the place the pass found.** The relative place without a read in `rank`, but a second event written by the engine for a person's command, and between the rank and that pass the order has no place `rank <order>` could print.
- **Keep the last pass's queue in a file for `rank` to read.** No network for `rank`, but mutable state outside the event store, as old as the last pass, that a rank's meaning would depend on.
- **Rank by issue number across repositories.** Numbers of different repositories say nothing about which came first.
- **Accept a rank of an order that is already brewing, for later.** It would mean nothing until part 2's ready set, and a person would see a rank that changes nothing; part 2 accepts it with the meaning it then has.
- **Keep the Brewery's issues ahead, ranked only among themselves.** The owners' requests would still jump every older target issue, the very order #239 asks to change; `first` says that when it is meant.
