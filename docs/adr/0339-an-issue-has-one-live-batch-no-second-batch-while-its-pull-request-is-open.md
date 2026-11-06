# 0339. An issue has one live batch: no second batch on a Brewery issue while its pull request is open

Date: 2026-11-06 · Status: Accepted · Amends [0105](0105-foedrum-order-orders-an-issue-again-as-a-human-command-recorded-on-batch-ordered.md) (when a Brewery issue on tap can be ordered again), [0334](0334-every-line-names-the-number-and-the-innkeeper-reads-it-from-its-input-s-source.md) (an older batch comes only from before this record) and [0240](0240-order-and-recipe-work-by-the-brewery-issue-on-both-surfaces.md) (`recipe` of an issue on tap orders it again under the same rule)

## Context
A number means its issue's latest batch ([ADR 0329](0329-one-number-per-piece-of-work.md)).
A batch on tap counted as ended, so a person could order a Brewery issue again while its pull request was open, and a failed check could then send the older batch back to brewing, behind a later batch its number now reached.
A target issue never had this: its claim is held until its pull requests end ([ADR 0105](0105-foedrum-order-orders-an-issue-again-as-a-human-command-recorded-on-batch-ordered.md)).

[ADR 0334](0334-every-line-names-the-number-and-the-innkeeper-reads-it-from-its-input-s-source.md) recorded the gap: an older batch waiting for a session had no command that opened it (#902).
A run on the fake host showed it was worse than a refused line: `foedrum brew 12 --take`, the line offered before #893, brewed the later batch to on tap and exited 0, with the older batch still Stuck.
A whole run went on the wrong batch and reported success.

The maintainer decided on 2026-11-06 to remove the older batch rather than give it a command.

## Decision

### The rule
- **`foedrum order <n>` of a Brewery issue on tap with a pull request with no recorded end is refused**, as a target issue's is through its held claim.
- **`foedrum recipe <n> <recipe> <reason>` is refused the same way**, since it orders through the same check (`orderRefusal`).
- **An issue on tap with no pull request can still be ordered again**, such as an approved plan, and so can one whose pull requests all have a recorded end, merged or closed.
- With two pull requests, the one with no recorded end refuses, and the line names only that one.
- **Then an issue has one live batch, so its number always reaches it**, and no command needs a batch id for this.

### The line says what to do
- A pull request may have merged with no recorded end yet, with no Cellar running.
  So the refusal says `foedrum brew <n>` or `foedrum serve` reads it if it ended, as [ADR 0336](0336-small-rough-edges-of-the-self-brew-trial.md) has it, and otherwise to close it first.
- **`foedrum brew <n>` and `foedrum mash <n>` of such a batch no longer offer `foedrum order`**, which would be refused: they say the pull request is still open, to close it first to order again, and that `foedrum brew <n>` reads it again once it ended.

### Nothing else brings an older batch back
Each of these is pinned by a test.
- **`fix_pull_request`** needs an open pull request on a batch on tap, which now has no later batch.
  One whose pull request ended has nothing to send back.
- **`retry`, `skip`, `rewind`, `recipe` and `lauter`** of a batch refuse it on tap.
- **A rebrew after a deleted Brewery issue** is of a target issue, whose claim is held while its pull request is open, deleted or not.
- **A sub-order** is ordered once, by the intake, only while it has no batch ([ADR 0211](0211-the-intake-starts-ready-sub-orders-at-their-order-s-rank-once-their-blockers-merged.md)), and a person's order of it is refused.
- **The intake** orders a Brewery issue only while it has no batch.

### A batch from before this record
- A Brewery may already hold an older batch, and nothing in its files or events changes.
  [ADR 0334](0334-every-line-names-the-number-and-the-innkeeper-reads-it-from-its-input-s-source.md)'s lines for it stay, since they are all such a batch has.
- **It can do what a batch id reaches:** `cancel`, `retry`, `skip`, `answer`, `approve`, `rewind`, `recipe` and `resume` by its id.
- **Two gaps stay, for it alone.**
  One waiting for a session has no command that opens its session, so a person cancels it by its id, and orders the issue again once nothing refuses that.
  `foedrum lauter <id>` of one records the lauter on that batch and then drives the latest, as it did before.

## Consequences
- **Brewery: no file changes.** A person who wants a second batch closes the pull request first.
- A person used to ordering again beside an open pull request gets a line that says so, and loses nothing the pull request's own branch holds.
- `/foedrum:order` and `/foedrum:recipe` say the same.
- No event changes, and a batch running now keeps working.

## Alternatives considered
- **`foedrum brew <batch id> --take`, tried in #912:** the lines already printed it, and it opened the right session.
  But `brew` takes an issue everywhere else, and the fake-host runs showed what the exception cost: with no Cellar, a foedrum that died with the session open left the batch Brewing, refused by that same printed command every time, so the exception had to grow to batches nothing drives, then to its limits for leases and drivers, then to a line per lane.
  All of it served a state that one refusal stops from arising.
- **`foedrum resume <batch id> <step>`:** on a Stuck batch `resume` already opens the finished attempt for reading and appends nothing ([ADR 0126](0126-foedrum-resume-opens-a-finished-attempt-s-session-in-its-worktree.md)), so a fresh session would give it two meanings in one lane.
- **Remove [ADR 0334](0334-every-line-names-the-number-and-the-innkeeper-reads-it-from-its-input-s-source.md)'s lines for an older batch:** less code, but a Brewery that already holds such a batch would lose the only words that reach it.
- **Fix `foedrum lauter <id>` here too:** one line and a test, but it can no longer arise from here on, so it would serve only a batch from before this record, which `cancel` by its id already ends.
