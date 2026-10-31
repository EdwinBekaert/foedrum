# 0283. `npm run demo` mashes a third order to a plan waiting for its review

Date: 2026-10-31 · Status: Accepted · Amends [0139](0139-npm-run-demo-brews-with-nip-and-shows-foedrum-brew-and-foedrum-resume.md) (the walkthrough's steps and a good run) and [0097](0097-npm-run-demo-is-a-script-on-serve-s-seams-with-the-tests-fakes.md) (the CLI calls the demo makes)

## Context
`npm run demo` brews a `nip-parallel` order twice, through a crash and from the terminal (ADR 0139, ADR 0185, ADR 0193), and never shows how a person starts work: `foedrum mash`'s Innkeeper's question, `foedrum answer`, and the Brewmaster's plan waiting Stuck for its review (ADR 0232, ADR 0275). The maintainer chose the shape on 2026-10-31 (#663): one new step after `replay`, all scripted and offline, with steps 1 to 11 as they are. ADR 0139's good run counts two batches, and the demo's CLI calls only read the store (ADR 0097).

## Decision
- **Step 12, `foedrum mash 3 --as ann`, mashes a third order.** Issue #3 is on the fake code host from the start, with no label, so the Cellar leaves it. `foedrum mash 3` runs as `foedrum brew` does (ADR 0232), through the same brew life of `scripts/demo/cellar.ts`, which takes the issue and `mash`. It stops at the Innkeeper's question (exit 4). The demo runs `foedrum answer 3-1 mash`, then `foedrum brew 3`, which drives the Brewmaster to a plan of two sub-orders that waits Stuck for its review (exit 3). The step shows `foedrum stuck`, the status comment and the plan comment.
- **The Innkeeper and the Brewmaster are scripted** beside Nip's brewers in the demo's script: one question with two recipes, and a plan whose second sub-order depends on the first, so the plan comment draws their order.
- **A good run also has the third batch Stuck as `plan_review`**: `foedrum mash` ended at the Innkeeper's question, `foedrum brew` left the plan waiting for its review, and order #3 has one status comment and one plan comment. Orders #1 and #2 have none.
- **The demo's CLI calls run as its user.** `foedrum answer` is the demo's one call that changes state. `cliFromCheckout` takes an optional `user`, and the demo gives it `ann` for every call, so what the answer records is ann's choice, never the machine's account name. The shipped `foedrum` passes no `user` and records the account as before.

## Consequences
- The demo shows how a person starts work, and that a plan waits for a person, which no other step shows.
- The demo runs two more scripted attempts, and its integration test's hang guard counts them.
- When the plan's wait changes (#588 adds `approve`), the step's text changes with it, and m1.md's transcript is made again.

## Alternatives considered
- **A Cellar life of its own for the mash:** left out. `foedrum mash` is `foedrum brew` with a flag, so the brew life runs it.
- **Keep the machine's account for `foedrum answer`:** left out. The status comment would show a second person choosing the recipe of ann's order, and the account name would reach m1.md's transcript.
