---
paths:
  - "**/scripts/remove-scratch.ts"
  - "**/scripts/remove-scratch/**"
  - "**/scripts/mutants.ts"
  - "**/scripts/mutants/**"
  - "**/scripts/mutant-verdict.ts"
  - "**/scripts/mutant-verdict/**"
  - "**/scripts/mutant-tests.ts"
  - "**/scripts/mutant-tests/**"
  - "**/scripts/mutant-coverage.ts"
  - "**/scripts/mutant-coverage/**"
  - "**/scripts/citations.ts"
  - "**/scripts/citations/**"
  - "**/scripts/issue-draft.ts"
  - "**/scripts/issue-draft/**"
  - "**/scripts/house-yeast.ts"
  - "**/scripts/house-yeast/**"
  - "**/src/brewers/house-yeast.ts"
  - "**/scripts/adr-index.ts"
  - "**/scripts/adr-index/**"
  - "**/test/**/remove-scratch*.test.ts"
  - "**/test/**/mutant*.test.ts"
  - "**/test/**/citations*.test.ts"
  - "**/test/**/issue-draft*.test.ts"
  - "**/test/**/house-yeast*.test.ts"
  - "**/test/**/adr-index*.test.ts"
  - "**/.claude/skills/brew-review/**"
  - "**/.claude/skills/brew-last-call/**"
---

# The /brew-review and /brew-last-call tools

The review skill (`.claude/skills/brew-review/`) and the last call (`.claude/skills/brew-last-call/`) run these scripts; each one's contract:

- `node scripts/remove-scratch.ts <scratch>` — remove a /brew-review scratch folder through `removeTree`. The scratch tree is a `git clone --shared` of the checkout, never a worktree, so nothing is registered in `.git/worktrees/`. A record that still points at `<scratch>/tree`, left by a run from before that change, goes too, and no other record is touched. It accepts only `.foedrum/tmp/<folder>/scratch` in the checkout, refuses anything else, and exits 1 when something could not be removed (the review skill runs it before and after a review)
- `node scripts/mutants.ts <tree> <answer.json> [<n> | --same-answer] [--touched <files.txt>]` — check the mutants in Brett's answer against a /brew-review scratch tree, or apply mutant `<n>` to it; with `--touched`, a mutant of a file the review's `files.txt` does not list is invalid (ADR 0054). With `--same-answer` (which needs `--touched`), append to the answer, marked `"source": "script"` unless an earlier run already did and removing nothing, the mutant that makes each touched boolean function return the one value all its assertions in the touched test files expect, and print `same answer: <file>:<line> <function> always <value>` for each, or `same answer: none` ([ADR 0278](../../docs/adr/0278-the-checker-writes-the-same-answer-mutant.md)). Brett gives each mutant as a one-line structured edit (`file`, `line`, `original`, `replacement`) of a file under `src/` or `scripts/`, never a patch; `scripts/mutants/core.ts` checks it against the rules in the review skill (stage 4) and applies it with an exact line replacement, both from `src/checks/mutants.ts`, the engine's, which imports nothing at run time ([ADR 0311](../../docs/adr/0311-brett-s-mutants-of-a-target-land-on-lines-the-change-added-in-a-code-area-of-the-test-map.md)). It prints one line per mutant and exits 1 when the answer cannot be read or mutant `<n>` is invalid
- `node scripts/mutant-verdict.ts <baseline.jsonl> <run.jsonl> [<test file>...]` — say whether a mutant was killed, from the test outcomes `scripts/test-outcomes-reporter.ts` wrote for a run without it and a run with it: only a test the mutant makes fail kills it, not the time budget, a coverage threshold or a test that fails anyway ([ADR 0040](../../docs/adr/0040-brett-covers-scripts-and-kills-need-a-failing-test.md)). Given the test files the run ran, it reads only their outcomes in the baseline (ADR 0303). Exits 1 when an outcome file cannot be read or the baseline has no passing test
- `node scripts/mutant-tests.ts <tree> <file>... [--direct]` — print the test files in `test/unit/`, `test/property/` and `test/chaos/` of a /brew-review scratch tree that import one of the given files directly or through one module in between: the tests the mutation check runs for mutants of those files, instead of the whole suite per mutant (ADR 0054). With `--direct`, only those that import one directly: the first round, and the wide list only for a mutant that survives it ([ADR 0171](../../docs/adr/0171-brett-s-mutants-run-against-their-file-s-direct-tests-first.md)). Prints nothing when no test file does
- `node scripts/mutant-coverage.ts <tree> <coverage-dir> <file>:<line>...` — for each mutated line, the test files of the wide list whose child process ran it in the coverage baseline (the V8 coverage files `NODE_V8_COVERAGE` wrote there, one per test file), and the file's own test file: `covered <file>:<line>: <test>...` or `not covered <file>:<line>`. A test file with no coverage file, or two, counts as running every line. It prints one line `fallback: <reason>` when the coverage cannot tell (no record names a test file of the run, a file it cannot read, no test file imports the files, a test file name with a space or line break), and the mutation check runs its two rounds instead ([ADR 0303](../../docs/adr/0303-brett-s-mutants-run-only-the-test-files-that-cover-their-line.md)). Exits 1 on a location that is not a line of a source file of the tree
- `node scripts/citations.ts <checkout> <answer.json>` — check that every finding in a /brew-review reviewer's answer cites a regular file of the checkout and a line within it; prints one line per finding (`ok`, `no location` or `unverified: <reason>`) and exits 1 when the answer cannot be read
- `node scripts/issue-draft.ts <draft.json>` — check a /brew-review pre-existing issue draft before stage 5 files it with `gh api`: exactly `title` and `body` strings, each key once, a one-line title of 1 to 256 characters that is not blank and has no control or invisible format character (a bidi override, a zero-width character), a body of at most 65,536 (GitHub's limits). Prints the title and exits 0, or prints one line per problem and exits 1, or exits 2 when no draft is named; the review skill runs its criteria copy before every write (#267, ADR 0094)
- `node scripts/house-yeast.ts select|list|recurring|record …` — the house-yeast rules of /brew-review ([ADR 0122](../../docs/adr/0122-house-yeast-for-foedrum-s-own-reviews-candidates-in-the-main-checkout-rules-per-lens.md)): `select <rules-dir> <files.txt> <lens> <out.md> [--budget <n>]` writes the active rules whose scope matches the changed files and the lens, within about 2,000 tokens, and names each rule selected, cut, invalid or without a scope; `list <candidates.jsonl>` prints the recorded lessons; `recurring <rules-dir> <candidates.jsonl> [--min <n>] [--since <date>]` prints, per active rule, most recorded first, the reviews that recorded its lesson strictly after the day it was proposed (its `created`), of all reviews recorded after that day, and the same after `--since` (default 2026-10-30, when sessions started loading the rules, #677), then the rules recorded in at least `--min` reviews (default 10) as candidates for a check, each a candidate for a promotion review ([ADR 0315](../../docs/adr/0315-a-rule-reviews-keep-recording-after-it-was-proposed-is-a-candidate-for-a-promotion-review.md)), and the rules no candidate ever named, so a renamed lesson never reads as 0; it reads only, and exits 0 once the files are read, 1 when one cannot be read (#685); `record <candidates.jsonl> <candidate.json> <rules-dir> [--asked]` appends a candidate and writes `<rules-dir>/<id>.md` when the lesson was recorded from a second review or asked for, never over an existing file, and then regenerates the session rule files in `<rules-dir>/../../.claude/rules/house-yeast/` as `npm run house-yeast:rules` does, exiting 1 without writing them when a rule file there is invalid ([ADR 0271](../../docs/adr/0271-foedrum-s-own-sessions-load-the-house-yeast-rules-as-generated-path-scoped-rule-files.md)). Candidates live in `.foedrum/house-yeast-candidates.jsonl` of the main checkout, shared by its worktrees
- `node scripts/adr-index.ts [--check]` — rebuild the table in `docs/adr/README.md` (number, title from the record's first line, its own status and what amends, supersedes, generalises or extends it) and each record's "Amended by" / "Superseded by" part of its status line, by reversing every record's `Amends [NNNN](…)` / `Supersedes [NNNN](…)` links; everything else on the line stays byte for byte. It prints one line per change; `--check` writes nothing and exits 1 when something differs. It writes nothing and names the file, and the line where there is one, on a record whose first or status line it cannot read, a link to a number with no record, two records with one number, a back clause it cannot drop from the text around it, or a README without its table before `## Template`. `/brew-last-call` runs it when a milestone closes; it is not part of `npm run check`, since the table lags between milestones (#312)
