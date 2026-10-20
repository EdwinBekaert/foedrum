# 0094. Reviewers show their evidence and mark pre-existing defects

Date: 2026-10-20 · Status: Accepted · Amends [0017](0017-test-first-recipes-and-tasting-lenses.md) (what a lens answers, and how its findings end) and [0022](0022-five-default-lenses.md) (the reporting rules of the five lenses)

## Context
Anthropic's write-up of its own pull-request reviewer ("Solving code review at Anthropic", claude.dev) traced most of a 50-round review to findings about code that had been there since the reviewer's first pass: "about 59% of it was code that had been there since the reviewer's first pass." Its reviewer labels each finding "Important, Nit, or Pre-existing, so a bug the PR didn't introduce doesn't look like the author's fault". Its guidance for review instructions asks for "a file and line as evidence instead of a guess from a name", to "flag the class of bug", and for "a summary that starts with a count", and its reviewer flags "changes that make a line in [CLAUDE.md] out of date".

Foedrum's lenses already ask for findings tied to specific lines and a concrete scenario, and `scripts/citations.ts` checks that each cited line exists. Nothing tells a finding the change introduced from one it only touched, so a defect in neighbouring code becomes part of the fix round of a pull request that did not cause it. A citation that exists can still rest on a guess from an identifier's name. And design conformance asks whether the documents still describe the code, without saying that a document outside the diff counts.

## Decision
- **A lens finding says whether the change introduced it** (`introduced`, in the answer format of `.claude/skills/brew-review/reviewer-prompt.md`). It is `false` when the defect is in lines the change neither adds nor alters, and the change does not make it worse. A finding that is not introduced does not count towards `request_changes`.
- **A pre-existing finding is never fixed in the review's round.** It is pre-existing when the reviewer says so or the reviewing session finds it so, with its reason; a finding the change did introduce or make worse is not, whatever the reviewer said. Stage 3 dismisses it with `pre-existing, to file (draft <k>)` and drafts its issue; stage 6 files the drafts after the secret scan, inside the user's one confirmation, reusing an open issue that already covers one, and the summary then names each issue (`.claude/skills/brew-review/SKILL.md`). A local or `--no-comment` run files nothing. Every finding still ends fixed or dismissed, as CLAUDE.md requires.
- **Every lens ties each claim about what code does to a line that shows it**, never to a name, a comment or a type alone, and names the class of bug when a finding is one case of a wider class, so the author looks for the other cases. Each lens also says when a defect was already there before the change (`defaults/lenses/*.md`, "Reporting"). These lens files are the Brewery's defaults too, so the Taster gets the same rules.
- **Design conformance flags a document that the change makes wrong**: a line of the contributor instructions, the architecture document, a guide or a decision record, quoted, also when that document is not in the change. The reviewers may read `docs/architecture.md` and `docs/brewers-and-recipes.md` at the head for it (`reviewer-prompt.md`), beside the criteria.
- **The summary's lens findings start with a count**: findings by severity, and how many were pre-existing (`.claude/skills/brew-review/summary-template.md`).

## Consequences
- A fix round only fixes what its pull request caused. Pre-existing defects become issues with a number once the user confirms a pull request run, sized and planned like any other; a local or `--no-comment` run leaves drafts.
- The citation check is unchanged: it reads only `file` and `line`, and an extra field passes through it.
- The Taster's own answer format, which does not exist yet (#26), takes the same field when it is built; a verify pass (#260) and diff-only rounds (#261) are issues of their own.

## Alternatives considered
- **A verify pass that confirms or refutes each finding before the fix round:** a mechanism of its own, with its own token cost; #260, for the Taster first.
- **A voting panel of verifiers, as Anthropic's reviewer does:** the Taster already takes about a third of a session's tokens; one verifier first, if any.
- **Adopting Claude Code Review or the security review GitHub Action:** both run on a paid plan or need an API key in CI, and Code Review never blocks a pull request ("A review never approves or blocks the pull request"), which is the opposite of the gate ([ADR 0067](0067-a-pull-request-of-only-plain-docs-needs-no-review-summary.md)).
- **A `REVIEW.md` in this repository:** the lenses are already the review's instructions, read from the base branch.
