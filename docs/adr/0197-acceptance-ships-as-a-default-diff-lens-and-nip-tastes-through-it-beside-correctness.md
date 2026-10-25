# 0197. Acceptance ships as a default diff lens, and Nip tastes through it beside correctness

Date: 2026-10-25 · Status: Accepted · Amends [0022](0022-five-default-lenses.md) and [0173](0173-necessity-ships-as-a-default-diff-lens.md) (the list of default lenses, now seven, and /brew-review's count of them), [0161](0161-lens-steps-run-a-taster-whose-findings-are-advisory-unless-the-step-blocks.md) (Nip's taste step) and [0185](0185-npm-run-demo-tastes-through-a-parallel-group-of-three-lenses.md) (Nip in `defaults/` keeps one Taster)

## Context
Every default lens asks whether the change is done right: correctness, security, cross-platform, design conformance, test design and necessity ([ADR 0022](0022-five-default-lenses.md), [ADR 0173](0173-necessity-ships-as-a-default-diff-lens.md)).
None asks whether it is the change the order asked for.
A diff can pass every lens and leave an item of its order unbuilt, or build something nobody asked for, and only the person who merges it would notice.
The Taster already gets the order as its input `order` (`defaults/brewers/taster.md`), so a lens can read it at no cost to the engine.
Foedrum's issues, and the orders a Brewery files the same way, list what to build as a checklist under a "What to build" heading.
#244 asked for an acceptance lens; the maintainer settled its first slice on 2026-10-25: the order's issue text only, before the mash plan's criteria (#388), the order's tab (#240) and the Innkeeper (#227) exist.

## Decision
- **A seventh default lens, acceptance** (`defaults/lenses/diff/acceptance.md`), checks the change against its order. It reads the order's "What to build" checklist and says of each item whether the change built it, built part of it, or left it out, each tied to a line of the change that shows it ([ADR 0094](0094-reviewers-show-their-evidence-and-mark-pre-existing-defects.md)), and names what the change builds that the order did not ask for. The default lenses are now **correctness, security, cross-platform, design conformance, test design, necessity and acceptance**. This amends the list in ADR 0022 as ADR 0173 left it; everything else in it stands.
- **Its verdict is any Taster's** (ADR 0161): each item left out or built in part is a finding the change introduced, `major` when the order cannot be closed without it and `minor` when what is missing is small, so the verdict is `changes` when such an item is major, else `approve`. What the change builds unasked is a finding too, its severity by what it costs to review and keep; a safeguard the order did not ask for is necessity's to weigh ([ADR 0173](0173-necessity-ships-as-a-default-diff-lens.md)), so the two lenses do not report it twice.
- **An order with no checklist** gets one minor finding about the change as a whole that says so, and `approve`: the lens has nothing to check against, and the order is not the change's fault.
- **Follow-ups are proposals in its out doc**, in its body, never issues it files: the Taster is read-only, and its out doc reaches the pull request's body and the status comment as every Taster's does.
- **Nip tastes through correctness and acceptance side by side**: its `taste` step becomes a parallel group ([ADR 0168](0168-a-parallel-group-runs-its-lens-steps-side-by-side.md)) of the lens steps `correctness` (`diff/correctness`) and `acceptance` (`diff/acceptance`), both advisory. This amends ADR 0161's Nip step; a Brewery that wants one Taster replaces `nip.jsonc` (ADR 0098).
- **`/brew-review` tastes through it too.** Stage 3 already starts one Taster per file of `defaults/lenses/diff/` (ADR 0173), so acceptance is its seventh. The bundle gets the body of each issue the pull request closes, as the acceptance lens's order (`order.md`), untrusted like the rest of the pull request; a pull request that closes no issue, and a local run, has none, and gets the one minor finding.
- The demo's own recipe, `nip-parallel` ([ADR 0185](0185-npm-run-demo-tastes-through-a-parallel-group-of-three-lenses.md)), stays as it is: its unit test replaces Nip's `taste` step with its own group, whatever Nip's is.

## Consequences
- Every Nip batch runs one more Taster: in the time of the slower of the two, since they run side by side, and at the tokens of one more Taster run (the lens, the order and the change).
- A Nip pull request whose order has an item left out that the order cannot be closed without has a `changes` verdict among its Tasters', so it opens as a draft ([ADR 0167](0167-a-brewed-pull-request-follows-one-layout-and-opens-as-a-draft-unless-every-taster-approves.md)), with the item in its body and the status comment.
- Nip's step ids change: the Taster's attempts are named `correctness` and `acceptance`, not `taste`, in the status comment, the event log and the scripted Nip of the tests.
- The planted-defect sample `test/fixtures/brew-review/planted-acceptance/` holds an order with a checklist and a change that passes correctness but leaves one item unbuilt and builds one thing unasked; a change to the lens is exercised on it, as on `planted-demo` for the others.
- `foedrum doctor` lists `defaults/lenses/diff/acceptance.md` in `Defaults in use`, as it lists every default (ADR 0098).
- Later, with #388, #240 and #227: the mash plan's acceptance criteria and the order's tab as inputs, and follow-ups handed to the Innkeeper.

## Alternatives considered
- **An acceptance check in correctness.** No extra session, but correctness reviews what code does, not what was asked, and the lenses would overlap again (ADR 0022).
- **Ship it without adding it to Nip, as necessity was, and as ADR 0185 kept Nip to one Taster.** No extra Taster run, but the one question no other lens asks would run only in recipes that name it, and an unbuilt item is the defect a quick fix is most likely to have; one more Taster beside correctness costs its tokens, not its time.
- **Acceptance blocking in Nip.** An item left out would send the batch back to Cellarman, but a checklist item a model judges unbuilt can be wrong, as a mutant can be equivalent (ADR 0017); advisory first, a recipe can set `"blocking": true`.
- **The lens files the follow-ups as issues.** It would need a write the Taster does not have, and a model would decide what enters the backlog; the Innkeeper (#227) is where they go.
