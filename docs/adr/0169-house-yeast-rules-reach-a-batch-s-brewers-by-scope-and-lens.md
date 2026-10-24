# 0169. House-yeast rules reach a batch's brewers, by scope and lens

Date: 2026-10-24 · Status: Accepted · Amends [0059](0059-attempt-plans-from-the-brewer-of-the-step.md) (`"houseYeast": true` loads, and the plan gives the rules as inputs) and [0018](0018-house-yeast-layers.md) (where each layer is read, the commit a repository's rules are read at, which layer wins), and [0122](0122-house-yeast-for-foedrum-s-own-reviews-candidates-in-the-main-checkout-rules-per-lens.md) (the selection moves into `src/`, and a rule's `lens` may name its folder)

## Context
House yeast is a Brewery's or repository's own review rules ([ADR 0015](0015-house-yeast.md)), in three layers ([ADR 0018](0018-house-yeast-layers.md)).
Only Foedrum's own `/brew-review` used them, through `scripts/house-yeast.ts`, which selects the rules whose scope matches the files a change touches, within about 2,000 tokens ([ADR 0122](0122-house-yeast-for-foedrum-s-own-reviews-candidates-in-the-main-checkout-rules-per-lens.md)).
In a user's batch nothing read them. A brewer file with `"houseYeast": true` failed the load ([ADR 0059](0059-attempt-plans-from-the-brewer-of-the-step.md)), no code read a Brewery's rules, and no attempt selected any.
So a Taster ([ADR 0161](0161-lens-steps-run-a-taster-whose-findings-are-advisory-unless-the-step-blocks.md)) reviewed through its lens alone, without the rules the team had learned (#434).

## Decision

### One selection, in `src/`
- The selection of ADR 0122 moves from `scripts/house-yeast/core.ts` into `src/brewers/house-yeast.ts`: reading rule files, the changed files of a `git diff --name-status`, the scope match, the priority, the budget and the cut. The script re-exports it, so `/brew-review` and a batch select the same way. `scripts/` is not shipped, so `src/` cannot import it.
- A rule's `scope.lens` names a lens by its name (`correctness`, as `/brew-review` writes it) or by its folder and name (`diff/correctness`, [ADR 0143](0143-lenses-in-two-folders-diff-and-plan.md)). A name alone matches the lens of that name in either folder. A brewer whose step has no lens gets only the rules without one.

### Where the rules are read
- **The Brewery layer** is the Markdown files directly in the Brewery's `house-yeast/`, read with the Brewery's files when `foedrum serve` starts, as recipes and brewers are. A change needs a restart.
- **A repository's layer** depends on its `houseYeast` in `foedrum.jsonc` (ADR 0018):
  - `"repo"` (the default): the regular `.md` files directly in `.foedrum/house-yeast/` of the repository. They are read with git in the repository's clone, at the commit the batch's change starts at: the base it last merged ([ADR 0164](0164-a-batch-merges-its-base-before-its-last-check.md)), else the commit it started at. A Taster's change starts there too (ADR 0161). They are never read from the attempt's worktree, so the batch's own commits cannot add a rule that steers its own brewers, or remove one that would catch them. The same holds for a pull request and its own review (ADR 0122). git reads them in two calls, `ls-tree` and `cat-file --batch`, with the runner's deadline and output limit. A link or a folder there is not a rule.
  - `"brewery"`: the Markdown files in the Brewery's `house-yeast/<owner>/<name>/`, read with the Brewery layer.
- **The defaults layer** stays inside Foedrum's lens and brewer prompts. Foedrum ships no rule files.
- When a repository rule and a Brewery rule have the same id, the repository's wins and the other is left out (ADR 0018: the more specific layer wins). Everything else is ranked as ADR 0122 ranks it.
- A rule file that does not read, whose id is not its file name, or whose language no extension has, is left out. It is named in the attempt's record (below), and serve does not refuse it. A failed git call, or a repository's rules that together pass the input limit of 1 MiB (ADR 0059), refuse the plan and name the reason, as an input that cannot be read does.

### What an attempt gets
- A brewer with `"houseYeast": true` loads. For each fresh attempt, the plan selects from both layers with the budget of ADR 0122 (about 2,000 tokens):
  - the rules whose scope matches a file the batch changed, from the commit above to the attempt's worktree's start (`git diff --name-status`, a deleted file counts for nothing);
  - and, when a rule names a lens, the lens of the step.
- A step that has changed nothing yet, such as a first step, gets only the rules that name no file.
- A resumed attempt gets no rules again: its session holds the ones its first attempt read ([ADR 0117](0117-a-retry-resumes-the-session-of-the-attempt-before-it-in-that-attempt-s-worktree.md)).
- Each selected rule is one input named `houseYeast`, after the brewer's own inputs and the change, with the source `house-yeast rule <id>, file <path>`. Like every input it is untrusted: tagged as data ([ADR 0041](0041-untrusted-input-in-per-prompt-nonce-tags.md)) and refused when it holds the prompt's nonce. Its text is the rule's heading and body, as `/brew-review`'s lens reads it.
- The default Taster asks for house yeast. Its instructions say to look for what the rules in `{houseYeast}` describe, and to start the `why` of a finding that breaks one with the rule's id. With no rule selected, its prompt is the same as before.

### The selection is recorded with the attempt
- The plan carries the ids it selected and cut and the paths it left out as invalid. The runner returns them with the attempt's end, and the driver records them on its `step.finished` as `houseYeast`. These are ADR 0018's usage counters, in the event store and never in a commit.
- An attempt whose plan fails, or whose process is lost, records none.

## Consequences
- A repository rule scoped to `src/**` and `diff/correctness` reaches the Taster of that lens in a batch that changes `src/`. It does not reach the same batch's other lenses, nor a batch that changes only `docs/`.
- An attempt of a brewer with house yeast makes two or three more git calls in the clone, before claude starts.
- A rule a batch adds to `.foedrum/house-yeast/` takes effect for the batches after it merges, never for its own.
- An invalid rule file shows only in the events of the attempts that left it out. `foedrum doctor` does not list it yet.
- `scripts/house-yeast/core.ts` imports `src/brewers/house-yeast.ts`, so `/brew-review` copies that file into its criteria too.
- `step.finished`'s JSON Schema gains an optional `houseYeast`. Earlier events stay valid.

## Alternatives considered
- **Rules from the attempt's worktree:** simpler, with no git call, but a batch's own commits would steer its own Taster.
- **A second selection in `src/`:** the two would drift, and `/brew-review` would no longer prove the batch's selection.
- **Refusing serve on an invalid Brewery rule:** stricter, but a repository's rules are read per attempt and could not be refused at the start. One treatment for both layers is easier to follow.
- **All selected rules as one input:** fewer tags, but no source could say which file each rule came from.
- **Recording the selection in an event of its own when the plan is made:** the plan has no event store, and the attempt's end already reaches it.
