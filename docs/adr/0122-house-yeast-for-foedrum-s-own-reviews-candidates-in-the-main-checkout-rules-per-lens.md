# 0122. House yeast for Foedrum's own reviews: candidates in the main checkout, rules per lens within a budget

Date: 2026-10-22 · Status: Accepted · Amends [0018](0018-house-yeast-layers.md) (where Foedrum's own candidates live until the state branch carries them)

## Context
[ADR 0018](0018-house-yeast-layers.md) has Foedrum dogfood the repository layer of house yeast: the review skill for Foedrum's own pull requests proposes rules into `.foedrum/house-yeast/`, in the pull request it reviews. It records a candidate (a lesson seen once) as an event on the state branch, and proposes a rule when the lesson recurs or a human asks. [ADR 0015](0015-house-yeast.md) selects rules by scope within a budget of about 2,000 tokens.

The review skill (`/brew-review`) runs in an engineer's Claude Code session, not in the engine: there is no state branch for Foedrum's own pull requests, and each pull request is worked in its own worktree under `.claude/worktrees/`, which the worktree cleanup removes once it merges. Issue #32 asks where candidates live until then, how the budget cuts rules, how a lens gets its rules, and which rules the summary flags for promotion to a check.

## Decision

### Candidates live in one local file in the main checkout
- A candidate is one line of JSON in `.foedrum/house-yeast-candidates.jsonl` at the root of the **main checkout**: the folder above `git rev-parse --path-format=absolute --git-common-dir`. Every worktree of the repository finds the same file, so a lesson from the review of one pull request is there for the review of the next, and it outlives the worktree that recorded it. `.foedrum/*` is git-ignored except `house-yeast/`, so the file is never committed.
- A line holds the `lesson` (a path-safe id, which becomes the rule's id), the `review` (the pull request's URL, or the branch of a local run), the `source` (a link to the finding or comment), the date it was `seen`, the `kind`, the `scope` and the `rule` in one or two sentences (`HouseYeastCandidate` in `src/schemas/house-yeast.ts`). Lines are only appended, one per occurrence, never rewritten, so two sessions recording at once cannot lose each other's line by a read-modify-write.
- **The same lesson** is the same `lesson` id. The reviewing session words a fixed finding as a rule, lists the recorded candidates (`node scripts/house-yeast.ts list`) and reuses the id of the one that says the same thing; deciding that two findings teach one lesson is judgement, so it stays with the session, and everything after it is the core's.
- **Recurring** means the lesson was recorded from two different reviews: two occurrences from one pull request (a review run twice, or two findings of one class) count once.
- The file is per machine: a lesson seen once on each of two machines does not recur. That is accepted until the state branch carries Foedrum's own candidates, which replaces the file.

### What becomes a candidate, and when a rule is proposed
- A finding of the lens reviews (or simplify) that was **fixed** in the round, or a human review comment on the pull request that asked for a change, is recorded as a candidate. A dismissed finding taught nothing, and a pre-existing one is an issue of its own ([ADR 0094](0094-reviewers-show-their-evidence-and-mark-pre-existing-defects.md)).
- `node scripts/house-yeast.ts record` appends the line and, when the lesson has now been recorded from two reviews, or the author asked for the rule (`--asked`), writes `.foedrum/house-yeast/<lesson>.md` in the checkout under review: the newest occurrence's scope, kind and rule, every occurrence's source, the newest date as `created`, `status: active`. It never overwrites a rule file that exists. The session commits the file on the pull request's branch, so the people who review the code approve the rule in the same pull request (ADR 0018); the review that proposes a rule does not use it.

### A lens receives the rules at the base that match the change
- The rules are review criteria, so they come from `<base>` like the lenses: copied into the bundle with `git show`, so a pull request can neither add a rule that steers its own review nor delete one that would catch it.
- For each lens (simplify included; Brett proposes mutants, not findings, and gets none), `node scripts/house-yeast.ts select` writes `<bundle>/house-yeast/<lens>.md`, and the reviewer prompt has the lens read it after the lens file. A finding that breaks a rule names the rule's id in its `rule` field.
- **Scope.** A rule matches the change when one file the change adds, alters or renames (by its new path; a deleted file counts for nothing) matches every file dimension the rule names: one of its `globs`, read by `path.posix.matchesGlob` (built into Node, so no dependency; a folder that starts with a dot is matched only by a glob that names it), and its `language`, read from the file's extension. Its `lens`, when it has one, must be the lens. A rule with neither globs nor a language matches every change. A `retired` rule is never selected.

### The budget is about 2,000 tokens per lens
- Each rule costs its text as the lens reads it (its heading and body), estimated as a quarter of its length in characters, rounded up. An estimate needs no tokenizer and no dependency, and a few percent either way do not matter for a budget of this size.
- Matching rules are taken in order of priority: a rule scoped to this lens first; then the narrower scope (globs, then a language alone, then the whole repository); then the newer `created`; then the id, so the order is the same on every run. A rule that would pass what is left of the budget is left out, and the next one is tried, so one long rule does not keep out the short ones after it.
- Nothing is cut silently (ADR 0015's "fixed size cap" alternative): `select` names every rule it left out, and the summary lists them, so a growing set of rules shows up as cut rules, which is when curation is due.

### Structural rules are promotion candidates
- A rule is a **promotion candidate** when its kind is `structural`: what it asks can be read from the code's text or layout (a call, an import, a file in a folder, a pattern), so a check can enforce it. A `semantic` rule is about what the code means and stays a prompt.
- The summary lists each structural rule proposed in the pull request or selected for a lens, with the check it could become (a Biome rule, a guard like `scripts/check-test-layers.ts`, a unit test that reads the source) or why none fits. Writing the check and retiring the rule is a pull request of its own (ADR 0015).

## Consequences
- A lesson that recurs across two of Foedrum's pull requests becomes a rule file in the second one, which its reviewers approve or remove; later reviews hand it to the lenses only for matching files.
- A lens reads at most about 2,000 tokens of rules on top of its criteria; until the rules grow, most reviews read none or a few.
- Candidates are local and unshared: they are lost with the main checkout and are not seen by other machines. A rule never needs them once it is proposed.
- `scripts/house-yeast.ts` and what it imports (`scripts/house-yeast/core.ts`, the house-yeast schema and the frontmatter reader) join the review criteria, so a pull request cannot change how its own rules are selected.

## Alternatives considered
- **Candidates committed in the repository:** shared across machines, but every review would add a commit of unreviewed text, and parallel pull requests would conflict on one file.
- **Candidates as GitHub issues or comments:** shared, but a public write per fixed finding, each asking for approval (#48), for a lesson that may never recur.
- **Candidates in the worktree's `.foedrum/tmp/`:** removed with the worktree, so a lesson could never recur across pull requests.
- **A real tokenizer:** exact, but a dependency for a budget that is an estimate anyway.
- **Stopping at the first rule that does not fit:** simpler to state, but one long rule would keep out every rule after it.
- **Rules from the head of the pull request:** a rule proposed in the pull request would steer its own review, and a pull request could remove the rule that catches it.
