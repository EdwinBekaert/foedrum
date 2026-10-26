# House yeast: the learning flywheel

Reviews produce lessons ("never swallow errors in this module", "use the shared retry helper").
Kept as one ever-growing rules file and read in full by every agent, such a flywheel quickly reaches tens of thousands of tokens per run, and adherence drops as the list grows.
House yeast is designed to stay small, relevant and enforceable ([ADR 0015](../adr/0015-house-yeast.md)):

1. **Rules carry metadata:** scope (repository, file globs, language, optionally a tasting lens, by its bare name such as `security`, which matches it in either folder, or by its folder and name such as `diff/security`, [ADR 0143](../adr/0143-lenses-in-two-folders-diff-and-plan.md), [ADR 0169](../adr/0169-house-yeast-rules-reach-a-batch-s-brewers-by-scope-and-lens.md)), kind (structural or semantic), source (the review that produced it), date, and counters for how often it was selected and violated.
2. **Selected per attempt, within a budget:** a brewer receives only rules whose scope matches the repository and files it works on (and, for a Taster, its lens), ordered by relevance and recency, within a token budget (default about 2,000 tokens); a step of several lenses together gets what each of its lenses would get apart, so up to that budget per lens ([ADR 0220](../adr/0220-a-taster-s-step-can-run-several-lenses-together.md)).
   Never the whole collection.
3. **Promoted to gravity readings:** a rule that can be checked mechanically (a lint rule, a search pattern, a test) becomes a deterministic check — enforced every time at zero tokens — and leaves the prompt.
4. **Curated:** a periodic curation step merges duplicates, folds similar rules together and retires rules that have not been relevant for a long time.
   Curation changes arrive as pull requests to the Brewery.
5. **Suppressions are scoped too:** "do not flag this again here" applies to the reviewing brewer and to the matching scope only.

**Three layers** ([ADR 0018](../adr/0018-house-yeast-layers.md)):

| Layer | Location | Holds | Approved by |
|---|---|---|---|
| Defaults | Shipped with Foedrum, mostly inside lens and brewer prompts | Craft rules that hold everywhere | Foedrum maintainers, measured with the Flight |
| Brewery | `house-yeast/` in the Brewery | Conventions across the organisation's repositories | Brewery owners, by pull request |
| Repository | `.foedrum/house-yeast/` in the target repository | Knowledge about that repository's code | The repository's owners, in the bottle that introduces the rule |

Selection draws from all layers within one budget; the more specific layer wins.
Repository rules are untrusted input, read only from registered repositories.
A repository can opt for the Brewery fallback (`houseYeast: "brewery"`), and nothing flows back to Foedrum's defaults automatically.

**In a batch** ([ADR 0169](../adr/0169-house-yeast-rules-reach-a-batch-s-brewers-by-scope-and-lens.md)): a brewer with `"houseYeast": true`, such as the default Taster, gets the rules for each fresh attempt.
The Brewery layer is the Markdown files directly in the Brewery's `house-yeast/`, read when `foedrum serve` starts.
A repository's layer is its `.foedrum/house-yeast/` at the commit the batch's change starts at, read with git in its clone, so a batch's own commits never steer its own brewers; with the Brewery fallback it is the Brewery's `house-yeast/<owner>/<name>/`.
A repository rule replaces a Brewery rule of its id.
The rules whose scope matches a file the batch changed, and the step's lens when a rule names one, are selected through the same code as `/brew-review` (`src/brewers/house-yeast.ts`); a step of several lenses together gets the rules each of its lenses would get apart, each once, in the order of its lenses ([ADR 0220](../adr/0220-a-taster-s-step-can-run-several-lenses-together.md)).
Each one is an untrusted input named `houseYeast`, and the ids selected and cut, with the files left out as invalid, are recorded on the attempt's `step.finished`.

**From lesson to rule:** a review finding that needed a fix, or a human review comment on a bottle, is recorded as a **candidate** on the state branch.
When the lesson recurs, or a human asks with `/foedrum remember`, it is proposed as a rule: one Markdown file with JSON frontmatter.
A repository-layer rule ships in the same bottle as the fix that taught it.
A human always approves a rule.

**Foedrum's own reviews** ([ADR 0122](../adr/0122-house-yeast-for-foedrum-s-own-reviews-candidates-in-the-main-checkout-rules-per-lens.md)): until the state branch carries them, `/brew-review` records candidates in `.foedrum/house-yeast-candidates.jsonl` of the main checkout, which every worktree shares.
Each lens reads the rules at the base whose scope matches the change, within the budget, and the summary names the rules the budget cut and flags structural rules as promotion candidates.
