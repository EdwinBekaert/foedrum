# 0276. The order a review reads holds its recorded scope decisions

Date: 2026-10-31 · Status: Accepted · Amends [0197](0197-acceptance-ships-as-a-default-diff-lens-and-nip-tastes-through-it-beside-correctness.md) (what `/brew-review`'s `order.md` holds, and the finding for an order with no checklist) and [0173](0173-necessity-ships-as-a-default-diff-lens.md) (what necessity counts as proof)

## Context
`/brew-review` writes `order.md` from the title and body of each issue the pull request closes (ADR 0197).
Over the merged pull requests #631 to #695, `node scripts/review-metrics.ts` (#683) shows the acceptance lens's findings dismissed 69% of the time, those of correctness, security, design conformance and test design 4 to 17%.
Of its 31 dismissals, 20 come from what the lens is given: scope narrowed, widened or settled in the issue's comments, the pull request's description or the ADR the change adds, which the lens never reads (#649, #690 against ADR 0240, #692's "One line is enough", #666's `--as` hint in ADR 0259).
4 come from its own rule that an order with no checklist gets one minor finding (#650, #651, #680, #682), which a person can only dismiss.
Necessity raised 3 findings in that range, all dismissed because the proof or the keep decision was already recorded (#635, #650, ADR 0230).
#260 closed a verifier stage for the same reason: a verifier given the same input could not refute these findings.

## Decision
- **`order.md` holds the recorded scope decisions.** After each closing issue's title and body come its comments whose `authorAssociation` is `OWNER`, `MEMBER` or `COLLABORATOR`, oldest first, each under its date, then one `## Pull request description` section with the pull request's body. All of it stays untrusted, like the rest of the pull request. No thread is cut until a long one is seen. A pull request that closes no issue but has a description gets an `order.md` with that section alone; a local run still has none.
- **Acceptance judges an item as recorded.** The order is the issue as it stands and the scope decisions recorded about it: those comments, the description, a decision record the change adds or cites. An item a record narrows, widens or settles is judged as the record says, and the lens cites the record in its notes; a departure a record names with its reason is not a finding.
- **An order with no checklist gets no finding.** The lens says so in its notes and approves.
- **Acceptance leaves to its notes** a defect in code the change does not add or alter, a limitation another open issue builds, a refactor of touched lines that only removes repeated code, and a documentation line the description says follows in another pull request.
- **Necessity reads the same `order.md`**, and a decision record, the issue or its maintainers' comments that name a safeguard's proof, cost or keep decision count as that proof; it reports only when no record gives one or the one given does not hold.

## Rejected
- **A verifier after the lens** (#260): it gets the same input, so it cannot tell a recorded decision from a missing item.
- **Every comment on the issue**: anyone can comment on a public issue, and a scope decision is the maintainers' to make; the text stays untrusted either way.
- **A cut for long threads**: none of Foedrum's issues has one long enough to need it yet.

## Consequences
- An `order.md` costs one more `gh` call per review and grows by the comments and the description, read by two Tasters instead of one.
- An issue whose scope changed must say so in a maintainer's comment, the description or an ADR; a decision made only in a session's chat still reaches no lens.
- A Brewery's default Taster reads the same lens text, so an order with no checklist now gets an approval with no finding there too; it gets no issue comments or description until an issue of its own feeds them to it.
- Measured by `node scripts/review-metrics.ts --from <this pull request>` over the next 15 merged pull requests: acceptance dismissed at or below 30%, and no "no checklist" rows.
