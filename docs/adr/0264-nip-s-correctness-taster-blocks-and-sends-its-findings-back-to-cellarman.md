# 0264. Nip's correctness Taster blocks and sends its findings back to Cellarman

Date: 2026-10-30 · Status: Accepted · Amends [0161](0161-lens-steps-run-a-taster-whose-findings-are-advisory-unless-the-step-blocks.md) (Nip's taste step, advisory), [0197](0197-acceptance-ships-as-a-default-diff-lens-and-nip-tastes-through-it-beside-correctness.md) (Nip's correctness and acceptance, both advisory) and [0193](0193-npm-run-demo-shows-a-tasting-loop.md) (Nip in `defaults/` unchanged, its Alternatives)

## Context
A Taster's findings are advisory unless its step sets `blocking` ([ADR 0161](0161-lens-steps-run-a-taster-whose-findings-are-advisory-unless-the-step-blocks.md)), and `defaults/recipes/nip.jsonc` sets none: Nip tastes through correctness and acceptance side by side, both advisory ([ADR 0197](0197-acceptance-ships-as-a-default-diff-lens-and-nip-tastes-through-it-beside-correctness.md)).
So the rounds machinery ([ADR 0190](0190-a-later-tasting-round-reviews-the-change-since-the-round-before.md), [0191](0191-the-step-a-findings-route-goes-back-to-records-a-disposition-for-each-finding.md), [0192](0192-a-findings-route-that-runs-out-of-rounds-goes-stuck-with-the-open-findings.md), [0196](0196-a-later-tasting-round-follows-any-earlier-round-that-reviewed.md), [0204](0204-a-dismissal-names-the-evidence-that-shows-it.md)) runs in no default recipe, only in the demo's own.
[ADR 0193](0193-npm-run-demo-shows-a-tasting-loop.md) left Nip out on purpose: "It would cost every Nip batch rounds of real brewer runs; a decision of its own, not a demo's."
That decision is this one, and cost was its only reason.
The maintainer's first live `nip` run showed what advisory costs instead: Brewery batch 12-2 (#566) opened foedrum#674 as a draft with a major from correctness that no step answered (a sub-order that is Ordered but not yet routed holds nothing, so two sub-orders whose touches overlap can both brew). The fix waited for a person, after the batch had ended.

## Decision
- **Nip's `correctness` step blocks**: `"blocking": true`, with `"onBlocked": { "findings": { "goto": "implement", "maxRounds": 2 } }`. Its `changes` verdict is settled as blocked by findings (ADR 0161), so the engine, not the model, holds the batch.
- **How the group routes** ([ADR 0168](0168-a-parallel-group-runs-its-lens-steps-side-by-side.md)): both Tasters run to their end, and only then does the group read its verdict. When correctness ended blocked, the batch goes back to `implement` with correctness's out doc as the route input (ADR 0128), and the round counts against correctness's route. Cellarman records a disposition for each finding (ADR 0191); the batch goes through `fine` and `green` again in its line, and the group runs both Tasters again, each on the change since the round before (ADR 0190, ADR 0196).
- **Two rounds at most.** A third `changes` from correctness makes the batch Stuck with its open findings (ADR 0192), and a person answers it as any Stuck batch.
- **`acceptance` stays advisory.** A checklist item a model judges unbuilt can be wrong (ADR 0197's reason, which still stands), and its findings go to the pull request's body and the status comment as before.
- **The cost, stated:** a batch whose correctness approves pays nothing more. Each round that blocks adds one Cellarman, one Finer and the green checks, and one more run of both Tasters, at most twice per batch. A Brewery that wants Nip advisory, or with other rounds, replaces `nip.jsonc` ([ADR 0098](0098-foedrum-s-defaults-load-under-the-brewery-s-files-and-a-brewer-input-can-name-a-lens.md)).
- **The demo's recipe stays its own** ([ADR 0193](0193-npm-run-demo-shows-a-tasting-loop.md)): one round, three lenses.

## Consequences
- A Nip pull request no longer opens with a correctness major that no step answered, unless the batch was Stuck and a person sent it on.
- A Nip batch can run up to three tasting rounds; the status comment's path line and the receipts show each.
- The changed default recipe is tried by the maintainer on the next real brew after the merge, as every default brewer's and recipe's change is.

## Alternatives considered
- **Keep Nip advisory** (ADR 0193). No extra runs, but foedrum#674 shows a major the batch could have fixed reaching a person instead.
- **Acceptance blocking too.** It would send an order's unbuilt item back to Cellarman, but its judgement can be wrong in ways correctness's is not (ADR 0197); a recipe can set it.
- **One round, as the demo's.** Cheaper, but a fix that leaves part of a finding open would go Stuck at once; two rounds is what #675 asked for.
