# 0339. `foedrum brew` takes a batch id to open the session an older batch waits for

Date: 2026-11-06 · Status: Accepted · Amends [0334](0334-every-line-names-the-number-and-the-innkeeper-reads-it-from-its-input-s-source.md) (`brew` takes no batch id; what an older batch's session lines, its status comment and `takeover`'s refusal offer), [0329](0329-one-number-per-piece-of-work.md) (a number means the latest batch, so `brew` needs one exception to reach another), [0222](0222-a-recipe-s-brewer-step-may-be-interactive.md) (the command a session line names, and `--new-window`), [0123](0123-foedrum-brew-drives-one-batch-under-an-owner-of-its-own.md) (what `brew` takes), [0124](0124-foedrum-takeover-hands-a-batch-to-another-driver-as-a-recorded-command.md) (what `takeover`'s refusal offers) and [0286](0286-foedrum-lauter-corrects-a-plan-at-gate-1-in-an-interactive-session.md) (a lauter of a batch id drives that batch)

## Context
A batch on tap counts as ended, so a later batch of its issue can be ordered, and a failed pull request can then send the earlier one back along a route through an interactive step.
That older batch waits for a session, and no command opened it ([ADR 0334](0334-every-line-names-the-number-and-the-innkeeper-reads-it-from-its-input-s-source.md) recorded the gap, #902).

A run on the fake host showed it is worse than a refusal.
Before #893 its lines offered `foedrum brew 12 --take`, which brewed the later batch to on tap and exited 0, while the older batch stayed Stuck: a whole run spent on the wrong batch, reported as a success.
Since #893, `foedrum status` and `foedrum stuck` offer `foedrum brew 12-1 --take`, which `brew` refused at once, and the status comment's Stuck line still offered the number.

`foedrum lauter <batch id>` had the same fault: it recorded the lauter on the batch it named, then drove the issue's latest batch, whose plan step ran, and the session the person chose never opened.
Its status lines, since #893, offer that command by id.

No shipped recipe takes the direct route: only `nip` has `onPullRequestFail`, and it goes back to a headless step, while `mash` and `decoction` have an interactive step and no pull request.
A Brewery's own recipe can.
From reading the code, not from a run, a shipped recipe gets there too through three choices of a person: an older `nip` batch sent back and Stuck, `foedrum recipe <id> mash`, and `foedrum lauter <id>` at its review.

## Decision

### `brew` takes a batch id for this one purpose
- **`foedrum brew <batch id> --take`, or `--new-window`, opens the session of the batch it names**, its issue's latest or not, driving that batch and no other.
  This is the one exception to "`brew` takes an issue".
- **A batch id alone is refused as a mistake of the command line**, in words that name `--take`: taking the batch from the driver that parked it is what the command is for, and the lines always print it.
- **A batch that waits for no session is refused**, and nothing is ordered or taken over: `batch 12-2 waits for no session, and foedrum brew takes an id only for one that does; foedrum brew 12 brews it`, by the number for a batch that is its issue's latest.
  An older batch's refusal says `foedrum stuck lists what it offers` when it is Stuck, otherwise `foedrum status shows it`, since its number would reach a later batch.
- **`mash` takes no batch id**, as before.

### One resolver, one named batch
- **`batchTarget` (`src/cli/brew-main.ts`) reads the id for `brew` as it does for `lauter`**, and `BrewRequest` carries it as `batch`.
- **`runBrew` works on the batch a request names**, `request.lauter ?? request.batch`, and on the issue's latest only when it names none.
  So `foedrum lauter <batch id>` opens the session of the batch it names too, as [ADR 0286](0286-foedrum-lauter-corrects-a-plan-at-gate-1-in-an-interactive-session.md) meant.

### What the lines offer
- **An older batch's session lines say `foedrum brew <id> --take`:** `foedrum status`, `foedrum stuck`, the status comment's Stuck line, `foedrum resume`'s refusal, and brew's and lauter's own last line, `run foedrum brew 12-1 --take in a terminal to open its session`, which keeps `--take` because the id needs it.
- **`takeover` of an older batch that no driver holds offers it when the batch waits for a session:** `no driver holds batch 12-1; foedrum brew 12-1 --take opens its session`.
  In any other lane it still offers no command.
- **A latest batch's lines keep its number**, also when a person gave its id.
- **No line about an older batch offers its number:**
  a brew of one that another driver takes during the run says `foedrum status shows it`, and one that goes on tap says nothing of `foedrum brew <n>` reading its pull requests, since that reads a later batch's.
- `/foedrum:brew` and `/foedrum:lauter` read the new last line and run `foedrum brew '<batch>' --new-window`.

## Consequences
- **Brewery: nothing to do.** No file changes, no event changes, and a batch already waiting opens by the printed command.
- A person whose older batch waits types the line it prints; an id on any other command works as before.
- The status comment of an older batch waiting for a session gets one more revision for its new words.
- A status comment of a batch that is its issue's latest does not change: its Stuck line reads the same number.

## Alternatives considered
- **`foedrum resume <batch id> <step>`:** it already takes an id and continues sessions, and [ADR 0231](0231-foedrum-resume-refuses-an-interactive-step-whose-session-is-open.md) only refuses a started attempt, so it would not be in the way.
  But on this Stuck batch `resume` opens the finished attempt for reading and appends nothing ([ADR 0126](0126-foedrum-resume-opens-a-finished-attempt-s-session-in-its-worktree.md)), so a fresh session would give it two meanings in one lane; its driver lets go after one attempt, and a plan that starts fresh runs headless ([ADR 0127](0127-foedrum-resume-takes-a-running-batch-over-and-continues-its-step-s-session.md)), where an interactive retry must open a fresh session ([ADR 0222](0222-a-recipe-s-brewer-step-may-be-interactive.md)).
- **A new command, such as `foedrum session <batch id>`:** one meaning, but one more command for a narrow case, with the same driver underneath, and every line would change for it.
- **`brew` takes a batch id for every batch:** more reach than the gap asks for, and it would bring back a second name for a batch that has a number, which [ADR 0329](0329-one-number-per-piece-of-work.md) removed.
- **An id without `--take` also works:** one word shorter, but a batch a Cellar parked is held by its lease, so the id alone would be refused for that and the person would get a second line to run.
- **Leave `foedrum lauter` for another issue:** its line would keep reaching the wrong batch, which #902 says no line may, and the fix is the same field.
