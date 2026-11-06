# 0329. One number per piece of work

Date: 2026-11-06 · Status: Accepted · Amends [0105](0105-foedrum-order-orders-an-issue-again-as-a-human-command-recorded-on-batch-ordered.md) (`order` of a live `<alias>#<n>` is refused), [0123](0123-foedrum-brew-drives-one-batch-under-an-owner-of-its-own.md) (`brew` of it too), [0124](0124-foedrum-takeover-hands-a-batch-to-another-driver-as-a-recorded-command.md) (`takeover` takes an issue), [0126](0126-foedrum-resume-opens-a-finished-attempt-s-session-in-its-worktree.md) and [0127](0127-foedrum-resume-takes-a-running-batch-over-and-continues-its-step-s-session.md) (`resume` takes an issue), [0281](0281-foedrum-approve-signs-off-a-plan-by-its-hash-and-puts-the-batch-on-tap.md) (`approve` takes an issue), [0144](0144-a-claimed-target-issue-gets-a-brewery-issue-that-is-its-order.md) (which name `status` and the session line use), [0202](0202-pause-and-continue-hold-an-order-or-the-whole-brewery-at-its-next-convenient-point.md) (`pause` and `continue` of a claimed order's number), [0205](0205-stop-makes-an-order-s-brewing-batches-stuck-at-once-and-retry-continues-them.md) (`stop` of it), [0208](0208-orders-are-claimed-in-rank-order-by-arrival-unless-a-person-moved-one-with-foedrum-rank.md) (`rank` of it), [0222](0222-a-recipe-s-brewer-step-may-be-interactive.md) (the command a session line names), [0240](0240-order-and-recipe-work-by-the-brewery-issue-on-both-surfaces.md) (`pause`, `stop` and `rank` no longer refuse the Brewery issue, and every batch command reads an issue as `recipe` does) and [0286](0286-foedrum-lauter-corrects-a-plan-at-gate-1-in-an-interactive-session.md) (`lauter` takes an issue)

## Context
One piece of work had three names, and each command took some of them: `foedrum#864`, the target repository's issue, for `brew` and `order`; `19`, its Brewery issue, for `brew` and `mash`; and `foedrum-864`, the batch, for `answer`, `retry`, `approve` and the rest.
The self-brew trial (#374) showed the cost: `foedrum brew foedrum#864` offered `foedrum mash foedrum#864`, which `mash` refuses, and a person working on issue 19 was told to run `foedrum answer foedrum-864 nip`.
`foedrum retry 19` parsed and then said there was no batch 19.

The maintainer decided on 2026-11-05: "If we take from a repository, we select that number, 864. When we give back to the repository, we also use 864. While 19 is alive, we do everything to 19."

## Decision

### Every command takes the number
- `replay`, `resume`, `retry`, `skip`, `answer`, `approve`, `lauter`, `rewind`, `cancel` and `takeover` take `<n>`, `#<n>` or `<alias>#<n>`, as `recipe` did since [ADR 0240](0240-order-and-recipe-work-by-the-brewery-issue-on-both-surfaces.md), or a batch id: a batch id always has a hyphen and no `#`, so the forms never overlap.
- **A number means its issue's latest batch.** A Brewery issue's own latest, or the latest claimed batch whose order it is.
- **One resolver reads it:** `namedWork` (`src/engine/claim-orders.ts`) gives the order, the latest batch and how to say it, from the fold.
- `pause`, `continue`, `stop` and `rank` resolve inside the store's transaction, since the claim is in the fold.
  **The pause stays keyed by the target order**, with the same events, so `pause 19` records what `pause foedrum#864` did, and a pause recorded before this lifts with `continue 19`.
  A sub-order's number keeps its refusal, which names its order.
- `foedrum status 19` lists only the batches whose order 19 is, as it did.
- **`foedrum lauter 19` means the latest batch.** ADR 0286's "names its batch, never the issue's later one" still holds for a batch id.

### `<alias>#<n>` is for crossing to the target
- **While the Brewery issue is alive, `<alias>#<n>` is refused with the number:** `foedrum#864 is Brewery issue #19; foedrum brew 19`, in every command that takes it, `status` included.
- **"Alive" reads only the fold, with no call to GitHub:** the latest batch of the target issue knows its Brewery issue and has not found it deleted (`liveOrderOf`).
- **Before the Brewery issue opens**, `<alias>#<n>` is all there is, and it works.
- **A Brewery issue a person deleted** is found by the batch's reopen or close (ADR 0144); then `<alias>#<n>` claims anew, in `order` and in `brew`, as it does when `foedrum order 19` finds the issue gone.
- A closed Brewery issue is ordered again by its number, `foedrum order 19`, which reopens it.
- `foedrum#864` stays where work crosses to the target: the claim, and what goes back there, such as the pull request's `Closes`.

### The batch id stays the engine's own
- **Commands keep accepting a batch id.** Comments already posted name one, it is what scripts may hold, and it is the only way to reach a batch that is not its issue's latest.
- A person never has to type it, and no new line should suggest it.
- `foedrum status` and `foedrum stuck` keep two columns: the batch id, since several batches of one issue differ by it, and `#19 (foedrum#864)`, the one place that shows the link.

### The words
- **Every line that would offer a form this refuses names the number now** (`calledAs`, or the Brewery issue the comment is on): `foedrum brew 19 --take` in the session lines of `foedrum status`, `foedrum resume` and the status comment, in place of the placeholder `<alias of owner/name>#n`; brew's `run foedrum brew 19 …`; `foedrum mash 19`, `foedrum order 19`, `foedrum continue 19`; `foedrum stop 19` in a `recipe` refused while the batch brews; and the release line's `foedrum order 19`, or `foedrum order foedrum#864` while no number is alive.
- **A printed command uses the bare number**, which every shell passes as it is, since `#` starts a comment.
- **Every other line follows in #881:** the lines that still name a batch id, which keep working, and the Innkeeper's question, which names the target number. That is the rest of this one rule; #881 needs an ADR of its own only if it decides something new.

## Consequences
- **A person with a running batch types the number or the batch id; both work.**
- **A line already posted that says `foedrum brew foedrum#864` is refused, with the number named.** One more command, and the line says which.
- No file in a Brewery changes, and no event changes: a running batch keeps working.
- The status comment of a batch waiting for a session gets one more revision for its new words.
- `brew --new-window` reads no store before it opens the window, so on a live `<alias>#<n>` the refusal shows in that window, and where no window can open its line repeats what was typed, whose run is then refused with the number. `/foedrum:brew` takes the number from the line it read, so it never gets there.
- `rankRefusal` and `decide`'s pause and stop lose their case for a claimed order's Brewery issue, which the command layer now resolves first; every caller goes through it. `decide`'s `orderRefusal` keeps its own, for a claimed batch whose id has no alias, and its words name the number.
- `foedrum status foedrum#864` is refused too. It only reads, but one rule for every command is easier to learn than one with an exception.

## Alternatives considered
- **Keep accepting `<alias>#<n>` for good:** nothing to refuse and nothing to migrate, but it keeps two names for one thing, which is what the maintainer's rule removes.
- **Ask GitHub whether the Brewery issue still exists:** finds a deletion sooner, but every command would need gh's login, and the batch's own reopen or close finds it when it matters.
- **Stop accepting a batch id:** one form, but comments already posted name one, and a batch that is not its issue's latest could not be reached.
- **Key pauses by the Brewery issue:** one name in the log too, but it needs a migration of recorded pauses and a pause before the issue opens would have no key.
- **A resolver per command:** each reads what it needs, but they would drift, as `orderRefOf` and `breweryOrdering` already had.
