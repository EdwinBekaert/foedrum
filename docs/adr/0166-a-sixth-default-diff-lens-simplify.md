# 0166. A sixth default diff lens: simplify

Date: 2026-10-24 · Status: Accepted · Amends [0017](0017-test-first-recipes-and-tasting-lenses.md) and [0022](0022-five-default-lenses.md) (the list of default lenses)

## Context
[ADR 0022](0022-five-default-lenses.md) ships five default diff lenses: correctness, security, cross-platform, design conformance and test design.
None of them asks whether the change is kept small, so nothing in a Brewery's batch reviews duplication, dead code or layers that only pass through.
Foedrum's own `/brew-review` has a simplify lens for that (`.claude/skills/brew-review/lenses/simplify.md`), but it proposes patches, which the skill applies in a scratch tree and runs the tests against.
A Taster cannot do that: it is read-only, and its out doc holds findings and a verdict ([ADR 0161](0161-lens-steps-run-a-taster-whose-findings-are-advisory-unless-the-step-blocks.md)).

## Decision
- A sixth default diff lens, **simplify** (`defaults/lenses/diff/simplify.md`), reviews the change for duplication, dead code, needless indirection and over-general code.
- It answers with findings like every other lens, never patches: the Taster's `tasting` out doc, with the file, the line and the smaller form in `why`. A recipe that wants Cellarman to act on them routes the step's findings back, as for any lens (ADR 0161).
- Its findings are `minor`, except a rule or logic stated twice that must change together, which is `major`, since one copy changed alone is a bug; it never reports a `blocker`. So a blocking simplify step holds a batch up only for duplication that can drift.
- It changes no behaviour it proposes: a smaller form that alters an error message, an output format or a public interface other code depends on is not a finding of this lens.
- The default lenses are now **correctness, security, cross-platform, design conformance, test design and simplify**. This amends the list in ADR 0017 and ADR 0022; everything else in them stands.
- Each other lens names simplify in its "Leave to other lenses" section, and simplify leaves bugs, risks, portability, documented decisions and test strength to them, so two lenses do not report the same line twice.
- No default recipe tastes through it yet: Nip tastes through `diff/correctness` only (ADR 0161). A Brewery's recipe names it as `"lens": "diff/simplify"`, and `foedrum doctor` lists it in `Defaults in use` as every default the Brewery keeps (ADR 0098).
- The review skill keeps its own simplify lens, which proposes patches for Foedrum's own pull requests in its stage 2, and also tastes through the shipped lens in its stage 3, with the other default lenses, so the shipped lens is exercised on every Foedrum pull request (ADR 0017).

## Consequences
- A recipe can review a batch's change for size as it does for bugs, at the cost of one more Taster run per lens step: its time and its tokens, a lens of about 600 words, the order, the change and the files it reads around it.
- The five older lenses grow by a few words each in "Leave to other lenses".
- A review of a Foedrum pull request starts one more Taster, for the shipped simplify lens.
- Two simplify lenses exist, one for the review skill and one shipped, with the same four kinds of finding; a change to what one looks for is a change to the other.

## Alternatives considered
- **Ship the review skill's lens as it is.** One file, but a Taster cannot apply a patch, and a patch in an out doc is text nobody runs the tests against.
- **The review skill reads only the shipped lens, with its own answer format for patches.** One list of what to look for, but the skill's lens adds rules for patches (no change to tests, settings or files outside the change), and changing the review skill's prompt needs a run against the planted-defect sample of its own.
- **Fold simplify into design conformance.** No new file, but design conformance judges a change by the repository's written rules, and most duplication breaks none of them.
- **Add it to Nip.** Every Nip batch would review its size, at the cost of one more Taster run each, for findings that are minor by design.
