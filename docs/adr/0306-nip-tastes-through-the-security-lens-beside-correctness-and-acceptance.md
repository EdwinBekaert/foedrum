# 0306. Nip tastes through the security lens beside correctness and acceptance

Date: 2026-11-03 · Status: Accepted · Amends [0197](0197-acceptance-ships-as-a-default-diff-lens-and-nip-tastes-through-it-beside-correctness.md) (Nip tastes through correctness and acceptance), [0264](0264-nip-s-correctness-taster-blocks-and-sends-its-findings-back-to-cellarman.md) (the group of two Tasters it routes) and [0224](0224-the-default-recipes-taste-apart-or-together-as-a-seeded-comparison-measured.md) (`together-nip` and Nip's apart, two lenses)

## Context
Nip tastes a change through two Tasters side by side: correctness, which blocks and sends its findings back to Cellarman ([ADR 0264](0264-nip-s-correctness-taster-blocks-and-sends-its-findings-back-to-cellarman.md)), and acceptance, which advises ([ADR 0197](0197-acceptance-ships-as-a-default-diff-lens-and-nip-tastes-through-it-beside-correctness.md)).
`defaults/lenses/diff/security.md` ships, but no default recipe runs it, so a Nip batch that crosses a trust boundary is checked for it only when the correctness Taster happens to notice.
On 2026-11-02 the session building #779 planned to put the failing tests' names, which a brewer writes, into the status comment, the merge brief and the Cellarman's prompt.
Whether that text is escaped (Markdown, HTML, `@` mentions, [ADR 0072](0072-the-status-comment-edits-as-revisions-in-the-ledger.md)) is the security lens's "untrusted text" question.
A design review caught it; in a Nip batch only a Taster could, and neither of Nip's two looks for it.
The maintainer decided on 2026-11-02 to add the security Taster to Nip now (#782); design questions answered before code (#226) stay in M6, and plan-level security marks come with #587.

## Decision
- **Nip's `taste` group gains a third lens step**, after correctness and acceptance: `{ "id": "security", "brewer": "taster", "lens": "diff/security" }`, the default Taster with the security lens. It runs in the same parallel group ([ADR 0168](0168-a-parallel-group-runs-its-lens-steps-side-by-side.md)), so the group's routing waits for all three Tasters before it reads correctness's verdict.
- **Security advises.** Its step sets no `blocking` and no `onBlocked`: its findings are listed in the pull request's body and the status comment as every Taster's are ([ADR 0161](0161-lens-steps-run-a-taster-whose-findings-are-advisory-unless-the-step-blocks.md)), and its verdict counts toward the draft rule, so a `changes` from it opens the pull request as a draft ([ADR 0167](0167-a-brewed-pull-request-follows-one-layout-and-opens-as-a-draft-unless-every-taster-approves.md)).
- **Why a `blocker` finding does not send the batch back.** Each round a blocking step sends back costs one Cellarman, one Finer, the green checks and one more run of all three Tasters, and correctness already blocks, sharing the batch's rounds. A security finding is often a question of trust a person settles (who controls an input, whether a layer already handles it), not a fix Cellarman can make alone; a draft with the finding in its body puts it before that person. A Brewery that wants security to block sets `"blocking": true` and an `onBlocked` findings route on the step in its own `nip.jsonc` ([ADR 0098](0098-foedrum-s-defaults-load-under-the-brewery-s-files-and-a-brewer-input-can-name-a-lens.md)).
- **`node scripts/tasting-compare.ts`'s Nip setups follow the recipe** ([ADR 0224](0224-the-default-recipes-taste-apart-or-together-as-a-seeded-comparison-measured.md)): `together-nip` tastes through the three lenses in one step, and `apart-nip` reads apart-7's correctness, acceptance and security attempts. ADR 0224's measured choice, Nip apart, stands: it was taken on two lenses, and a third apart costs no more wall-clock time; the next comparison measures the three.
- The demos keep their own recipes: `npm run demo`'s `nip-parallel` already tastes through correctness, security and test design ([ADR 0185](0185-npm-run-demo-tastes-through-a-parallel-group-of-three-lenses.md), [ADR 0193](0193-npm-run-demo-shows-a-tasting-loop.md)), and the ladder's recipe is its own ([ADR 0294](0294-npm-run-demo-ladder-walks-an-order-across-two-repositories.md)).

## Consequences
- Every Nip batch runs one more Taster in each tasting round: the tokens of one more Taster run (the lens, the order and the change), in the time of the slowest of the three, since they run side by side.
- A Nip pull request that handles untrusted input lists what the security Taster found about it, and opens as a draft when it asked for changes.
- The status comment's path line, the event log and the scripted Nip of the tests show `security #1` beside `correctness #1` and `acceptance #1`.
- The changed default recipe is tried by the maintainer on the next real brew after the merge, as every default recipe's change is.

## Alternatives considered
- **Security blocking in Nip.** A trust question would go back to Cellarman, which cannot answer who controls an input, at the cost of a full round; a Brewery can set it.
- **Fold the security questions into the correctness lens.** No extra session, but the lenses would overlap again ([ADR 0022](0022-five-default-lenses.md)), and correctness's checklist would grow by a lens's worth.
- **Wait for #226 and #587.** The Brewmaster answering design questions and plan-level security marks catch the question before code, but they come in later milestones; the Taster catches it after code, today, for one Taster run.
