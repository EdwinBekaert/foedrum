# 0271. Foedrum's own sessions load the house-yeast rules as generated path-scoped rule files

Date: 2026-10-30 · Status: Accepted · Amends [0015](0015-house-yeast.md) (the rules a session loads have no budget, only their paths) and [0122](0122-house-yeast-for-foedrum-s-own-reviews-candidates-in-the-main-checkout-rules-per-lens.md) (Foedrum's own rules reach the sessions that write the code, not only the lenses of `/brew-review`)

## Context
[ADR 0122](0122-house-yeast-for-foedrum-s-own-reviews-candidates-in-the-main-checkout-rules-per-lens.md) gives the rules in Foedrum's `.foedrum/house-yeast/` to the lenses of `/brew-review`, after the code is written.
The Claude Code sessions that write Foedrum's own pull requests never see them, so a lesson is written, flagged and fixed again: after its rule landed on main, `adr-amends-every-record-whose-rule-it-changes` was recorded again in 32 of 45 reviews, `near-miss-for-every-rule-of-a-text-form` in 16 of 22 and `guard-on-two-paths-tested-on-each` in 10 of 13 (#671).
[ADR 0268](0268-the-brewers-that-write-a-change-get-the-house-yeast-rules-of-every-lens.md) gives the rules to a brewed batch's writers; this record gives them to Foedrum's own sessions (#677).

Claude Code loads a Markdown file under `.claude/rules/`, found in subfolders too, at launch when it has no `paths` frontmatter, and only when the session reads or changes a file one of its `paths` globs matches when it has one.
The globs are matched from the folder that holds `.claude/`: a session starts in the main checkout and works in a worktree under `.claude/worktrees/`, so a file there is `.claude/worktrees/<branch>/src/…` to the matcher.

## Decision
- `npm run house-yeast:rules` (`scripts/generate-house-yeast-rules.ts`) writes `.claude/rules/house-yeast/` from `.foedrum/house-yeast/`, read with `readRules`: one file per set of paths, named after the lowest of its rules' globs or language so the order the rules are read in does not change it, holding each of its rules as a lens reads it (`section`), by id, under a line that says the file is generated.
- A rule's paths are its globs, each under any folder (`**/` before it), so they match in a worktree too. A rule with only a language gets that language's extensions (`**/*.{ts,tsx,mts,cts}`, or `**/*.md` for a language of one extension, since a brace of one item matches only itself). A rule with neither matches every file (`**/*`, in `everywhere.md`), as it matches every change (ADR 0015). A rule with both is scoped by its globs alone, since `paths` cannot ask for both; every rule so far already pins the language in its globs.
- Every active rule is given, whatever lens it names, as ADR 0268 does for a batch's writers: the session writes the change. A retired rule is left out. There is no budget: a file loads only for its own files, and Foedrum's 27 rules come to about 1,950 tokens in all, under the 2,000 of one lens.
- A rule file that cannot be read fails the generator, naming it.
- `/brew-review`'s `record` (`scripts/house-yeast.ts`) regenerates the folder itself when it writes a rule, through the same code as `npm run house-yeast:rules`, so a review that proposes a rule commits its session rule files with it; a step the code takes needs no step in the skill.
- A unit test fails while the committed folder differs from what the generator writes, as `test/unit/json-schema.test.ts` does for `schemas/`: the net for a rule changed by hand, whose pull request runs `npm run house-yeast:rules`, as the test's name says.
- `/brew-review`'s selection does not change: its lenses get the rules at the base, per lens, within the budget (ADR 0122).

## Consequences
- A session started after the merge, in the main checkout, loads the rules for the files it reads or changes, before the review that would flag them.
- A session reads the main checkout's `.claude/rules/`, so a rule added on a branch reaches sessions only after it is merged and the session restarts.
- `prose-counts-follow-the-folder-they-describe` names `.claude/**`, and every worktree is under `.claude/worktrees/`, so that rule loads for every file a session in a worktree reads, about 90 tokens.
- The generated files are about 16 small files, which `node scripts/instruction-sizes.ts` counts with the rest of `.claude/rules/`.

## Alternatives considered
- **The rules in CLAUDE.md:** every session would load all of them, whatever it works on, and CLAUDE.md is loaded into every session already.
- **One generated file per rule:** 27 files where 16 do, with no difference in what a session loads.
- **One file without `paths`:** loaded at launch in every session, test-design rules for a docs change included.
- **The rules' own files under `.claude/rules/`, linked:** their frontmatter is JSON with `scope.globs`, not `paths`, so Claude Code would load every one at launch.
