# 0299. A structural rule becomes a Biome GritQL plugin whose message names the fix

Date: 2026-11-01 · Status: Accepted · Amends [0122](0122-house-yeast-for-foedrum-s-own-reviews-candidates-in-the-main-checkout-rules-per-lens.md) (the check a structural rule can become)

## Context
[ADR 0122](0122-house-yeast-for-foedrum-s-own-reviews-candidates-in-the-main-checkout-rules-per-lens.md) makes a structural house-yeast rule a promotion candidate: what it asks can be read from the code's text, so a check can enforce it, and it names three kinds of check: a Biome rule, a guard like `scripts/check-test-layers.ts`, or a unit test that reads the source.
Biome's built-in rules cannot be extended, and a guard script or a source-reading test parses the code again by hand.

Issue #749 found 28 casts in `src/` that hide an assumption nothing checks: `(error as Error).message`, `(error as NodeJS.ErrnoException).code`, a caught value cast to an object shape, and `map.get(key) as Value`.
They are replaced by shared helpers (`messageOf`, `errorCode` and `sqliteErrorCode` in `src/platform/errors.ts`, `foldedBatch` in `src/engine/fold.ts`), and new code must not bring them back.

Biome 2, already the linter (`npm run lint` is `biome check`), runs GritQL plugins: a `.grit` file holds a pattern over the syntax tree and the diagnostic it reports.
A probe on 2026-11-01 found that a pattern reports as an error that fails `biome check`, and that a `biome.json` override scopes plugins to the files it includes.

## Decision
- **A structural rule that a pattern of the syntax tree can read becomes a Biome GritQL plugin.** It needs no dependency and no script of its own, and runs wherever `npm run lint` runs: `npm run check`, the push gate's `npm run check -- --no-tests`, and CI.
- **Plugins live in `biome-plugins/`**, one `.grit` file per pattern, with a comment that says what the pattern finds and why, and the ADR or issue behind it.
- **`biome.json` lists them in an `overrides` entry** whose `includes` names the files the rule is for.
  The four of #749 are for `src/**/*.ts`: a test's fake may cast what it built itself, and tests hold casts the rule is not about.
- **Each pattern's message names the fix:** the helper to call and the module it is in (`Read an error's message with messageOf(error) from src/platform/errors.ts, never a cast to Error.`), so the person or brewer who meets it needs no other page.
- **A pattern matches only the form it forbids.** `#749`'s lookup pattern skips a cast that keeps `| undefined` and a lookup without a key (SQLite's `statement.get()`), and the object-shape pattern matches only a catch clause's own value, so code the rule is not about needs no ignore comment.
- **A plugin is proven red on a planted file** before it is relied on: a file of the forbidden forms and the allowed ones beside them, linted once with the plugin (the forbidden forms reported, the allowed ones not) and once without the file (clean). The output goes in the pull request; there is no unit test for a Biome rule, since a test would have to start Biome.
- **The judgement behind a plugin stays a semantic rule.** What a pattern cannot read (a value from a process's output or a model's text cast to its type, a helper written a second time) is a semantic house-yeast rule for the lenses; #749's is `outside-values-parsed-never-cast`.

## Consequences
- A cast #749 forbids fails `npm run check` in `src/`, with the helper to use in the message; the push gate and CI fail on it too.
- A pull request that adds a structural rule's check adds a `.grit` file and an override line, and retires the rule, instead of a script.
- A plugin's pattern is code in GritQL, which Biome versions may read differently. A Biome update that makes a pattern match more shows up as new diagnostics in `npm run lint`; one that makes it match nothing does not, since `src/` holds no forbidden cast for it to report. That is accepted: no check runs the planted file again, and a Biome update that touches plugins is proven on a planted file again by hand.
- Scripts and tests keep their casts (`scripts/` holds about 30 of the forms the rule forbids in `src/`); an override can widen a plugin's reach later.

## Alternatives considered
- **A guard script like `scripts/check-test-layers.ts`:** it would have to find casts with regular expressions or a parser of its own, which Biome already has.
- **A unit test that reads the source:** the same parsing problem, and the failure would be a test's, not the linter's at the line.
- **oxlint or an anti-slop lint package:** a second linter and a new dependency for rules Biome can run.
- **Plugins over every file:** test fakes cast what they build, and 17 such casts in `test/` would need ignore comments for no gain.
