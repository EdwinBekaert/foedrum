---
paths:
  - "scripts/remove-scratch.ts"
  - "scripts/remove-scratch/**"
  - "scripts/mutants.ts"
  - "scripts/mutants/**"
  - "scripts/mutant-verdict.ts"
  - "scripts/mutant-verdict/**"
  - "scripts/mutant-tests.ts"
  - "scripts/mutant-tests/**"
  - "scripts/citations.ts"
  - "scripts/citations/**"
  - "scripts/issue-draft.ts"
  - "scripts/issue-draft/**"
  - "scripts/house-yeast.ts"
  - "scripts/house-yeast/**"
  - "scripts/adr-index.ts"
  - "scripts/adr-index/**"
  - "test/**/remove-scratch*.test.ts"
  - "test/**/mutant*.test.ts"
  - "test/**/citations*.test.ts"
  - "test/**/issue-draft*.test.ts"
  - "test/**/house-yeast*.test.ts"
  - "test/**/adr-index*.test.ts"
  - ".claude/skills/brew-review/**"
  - ".claude/skills/brew-last-call/**"
---

# The /brew-review and /brew-last-call tools

The review skill (`.claude/skills/brew-review/`) and the last call (`.claude/skills/brew-last-call/`) run these scripts; each one's contract:

- `node scripts/remove-scratch.ts <scratch>` — remove a /brew-review scratch folder through `removeTree`. The scratch tree is a `git clone --shared` of the checkout, never a worktree, so nothing is registered in `.git/worktrees/`. A record that still points at `<scratch>/tree`, left by a run from before that change, goes too, and no other record is touched. It accepts only `.foedrum/tmp/<folder>/scratch` in the checkout, refuses anything else, and exits 1 when something could not be removed (the review skill runs it before and after a review)
- `node scripts/mutants.ts <tree> <answer.json> [<n>] [--touched <files.txt>]` — check the mutants in Brett's answer against a /brew-review scratch tree, or apply mutant `<n>` to it; with `--touched`, a mutant of a file the review's `files.txt` does not list is invalid (ADR 0054). Brett gives each mutant as a one-line structured edit (`file`, `line`, `original`, `replacement`) of a file under `src/` or `scripts/`, never a patch; `scripts/mutants/core.ts` checks it against the rules in the review skill (stage 4) and applies it with an exact line replacement. It prints one line per mutant and exits 1 when the answer cannot be read or mutant `<n>` is invalid
- `node scripts/mutant-verdict.ts <baseline.jsonl> <run.jsonl>` — say whether a mutant was killed, from the test outcomes `scripts/test-outcomes-reporter.ts` wrote for a run without it and a run with it: only a test the mutant makes fail kills it, not the time budget, a coverage threshold or a test that fails anyway ([ADR 0040](../../docs/adr/0040-brett-covers-scripts-and-kills-need-a-failing-test.md)). Exits 1 when an outcome file cannot be read or the baseline has no passing test
- `node scripts/mutant-tests.ts <tree> <file>...` — print the test files in `test/unit/`, `test/property/` and `test/chaos/` of a /brew-review scratch tree that import one of the given files directly or through one module in between: the tests the mutation check runs for mutants of those files, instead of the whole suite per mutant (ADR 0054). Prints nothing when no test file does
- `node scripts/citations.ts <checkout> <answer.json>` — check that every finding in a /brew-review reviewer's answer cites a regular file of the checkout and a line within it; prints one line per finding (`ok`, `no location` or `unverified: <reason>`) and exits 1 when the answer cannot be read
- `node scripts/issue-draft.ts <draft.json>` — check a /brew-review pre-existing issue draft before stage 5 files it with `gh api`: exactly `title` and `body` strings, each key once, a one-line title of 1 to 256 characters that is not blank and has no control or invisible format character (a bidi override, a zero-width character), a body of at most 65,536 (GitHub's limits). Prints the title and exits 0, or prints one line per problem and exits 1, or exits 2 when no draft is named; the review skill runs its criteria copy before every write (#267, ADR 0094)
- `node scripts/house-yeast.ts select|list|record …` — the house-yeast rules of /brew-review ([ADR 0122](../../docs/adr/0122-house-yeast-for-foedrum-s-own-reviews-candidates-in-the-main-checkout-rules-per-lens.md)): `select <rules-dir> <files.txt> <lens> <out.md> [--budget <n>]` writes the active rules whose scope matches the changed files and the lens, within about 2,000 tokens, and names each rule selected, cut, invalid or without a scope; `list <candidates.jsonl>` prints the recorded lessons; `record <candidates.jsonl> <candidate.json> <rules-dir> [--asked]` appends a candidate and writes `<rules-dir>/<id>.md` when the lesson was recorded from a second review or asked for, never over an existing file. Candidates live in `.foedrum/house-yeast-candidates.jsonl` of the main checkout, shared by its worktrees
- `node scripts/adr-index.ts [--check]` — rebuild the table in `docs/adr/README.md` (number, title from the record's first line, its own status and what amends, supersedes, generalises or extends it) and each record's "Amended by" / "Superseded by" part of its status line, by reversing every record's `Amends [NNNN](…)` / `Supersedes [NNNN](…)` links; everything else on the line stays byte for byte. It prints one line per change; `--check` writes nothing and exits 1 when something differs. It writes nothing and names the file, and the line where there is one, on a record whose first or status line it cannot read, a link to a number with no record, two records with one number, a back clause it cannot drop from the text around it, or a README without its table before `## Template`. `/brew-last-call` runs it when a milestone closes; it is not part of `npm run check`, since the table lags between milestones (#312)
