# 0450. No command takes a batch id, and no line offers one

Date: 2026-11-27 · Status: Accepted · Amends [0329](0329-one-number-per-piece-of-work.md) (a batch id is no longer taken), [0334](0334-every-line-names-the-number-and-the-innkeeper-reads-it-from-its-input-s-source.md) (an older batch is no longer offered by its id), [0240](0240-order-and-recipe-work-by-the-brewery-issue-on-both-surfaces.md) (`recipe` takes no batch id) and [0286](0286-foedrum-lauter-corrects-a-plan-at-gate-1-in-an-interactive-session.md) (`lauter` takes no batch id)

## Context
[ADR 0329](0329-one-number-per-piece-of-work.md) decided that while a Brewery issue is alive, a person names its work by that number, and refused `<alias>#<n>` then, with the number to use.
It left a batch id taken by every command that takes `BatchOrIssue`, and [ADR 0334](0334-every-line-names-the-number-and-the-innkeeper-reads-it-from-its-input-s-source.md) offered an older batch by its id, since a number means the latest batch.
A claimed issue's batch id carries the target issue's number (`foedrum-1163`), so it reads as the Foedrum issue.
On 2026-11-26 `foedrum recipe foedrum-1163 deep-brew "…"` put `recipe:deep-brew` on Brewery issue #32, as it should, and the person read it as a label on Foedrum's #1163.
The maintainer decided that day that a command says "do this on the Brewery issue" and takes no batch id, and that nobody uses an older batch.

## Decision
- **No command takes a batch id.**
  `handover`, `replay`, `resume`, `retry`, `skip`, `answer`, `approve`, `lauter`, `rewind`, `cancel`, `takeover` and `recipe` refuse one with the number to use, as `<alias>#<n>` is refused: `foedrum-1163 is Brewery issue #32; foedrum recipe 32`.
  Before the Brewery issue is open the line offers `<alias>#<n>`, and a batch id the log has not is refused naming it.
  One resolver does it for every command, `namedBatchId`, beside `namedWork` (`src/engine/claim-orders.ts`).
- **No line Foedrum prints offers a batch id.**
  `calledAs` gives the number, or `<alias>#<n>` before the Brewery issue opens, and `saidAs` says `#<n>` or `<alias>#<n>`, for an older batch as for the latest.
  `foedrum stuck` has no `run as:` line any more, and the plugin's skills no longer look for one.
- **An older batch is named by no command.**
  A number reaches the latest batch of its issue, and an older one is reached by none.
  `foedrum stuck` still lists an older batch that came back Stuck, with its options, but offers no command for it.

## Consequences
- No compatibility is kept: nothing is written differently, so no event or field changes, and a script that passed a batch id gets the refusal and the number.
- The exception of [ADR 0334](0334-every-line-names-the-number-and-the-innkeeper-reads-it-from-its-input-s-source.md)'s "one exception" section goes; its other rules stand, among them the batch ids that headings, notices and generic refusals keep, which offer no command.
- A refusal for a batch id is the same text from every command and from `brew`'s `lauter`, with the command's own name in it.
- A takeover of an older batch that no driver holds now offers `foedrum brew <n> drives it`, as a latest batch does, though `brew <n>` drives the latest batch: no command can name the older one to take over.

## Alternatives considered
- **Keep a batch id for an older batch only:** the only way to reach it, but the person who used it on 2026-11-26 read a batch id as a Foedrum issue, and nobody uses an older batch.
- **Read a batch id as its issue's number:** no refusal to learn, but a command would then act on the latest batch of the issue, which may not be the batch the id names.
