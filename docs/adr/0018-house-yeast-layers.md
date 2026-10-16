# 0018. House yeast in three layers

Date: 2026-10-14 · Status: Accepted · Amends [0015](0015-house-yeast.md)

## Context
[ADR 0015](0015-house-yeast.md) keeps all learned rules in the Brewery's `house-yeast/`. Many lessons, however, are about one repository's code ("in `billing/`, amounts are integers in cents"). Stored in the Brewery, such a rule is separated from the code it describes: a refactoring in the repository does not touch it, the repository's owners never review it, and a second team running Foedrum on the same repository does not see it. Other lessons hold for every repository of an organisation, and a few hold everywhere.

ADR 0015 also left four questions open: the file format, who approves a rule, when a lesson becomes a rule, and whether Foedrum learns from its own development.

## Decision

### Three layers
| Layer | Location | Holds | Approved by |
|---|---|---|---|
| **Defaults** | Shipped with Foedrum, mostly inside lens and brewer prompts | Craft rules that hold everywhere | Foedrum maintainers, measured with the Flight |
| **Brewery** | `house-yeast/` in the Brewery | Conventions across the organisation's repositories | Brewery owners, by pull request |
| **Repository** | `.foedrum/house-yeast/` committed in the target repository | Knowledge about that repository's code | The repository's owners, in the bottle that introduces the rule |

- **Selection** draws from all three layers within the single token budget of ADR 0015. When rules conflict, the more specific layer wins: repository, then Brewery, then defaults.
- **The lesson ships with the fix.** A repository-layer rule learned during a batch is committed in the same bottle as the code change that taught it, so the reviewers who know the code approve both. When a refactoring makes a rule obsolete, the same pull request can change or remove it.
- **Fallback:** per repository, `houseYeast` in `foedrum.jsonc` is `"repo"` (default) or `"brewery"`. With `"brewery"`, repository-layer rules are kept in the Brewery under `house-yeast/<repository>/`, for repositories whose owners do not accept such files.
- **Trust:** rules read from a target repository are repository content, treated like other untrusted input: delimited and marked as data, never instructions ([ADR 0041](0041-untrusted-input-in-per-prompt-nonce-tags.md)), and only read from repositories registered in the Brewery.
- **Nothing flows back automatically.** Rules never travel from a Brewery or a repository to Foedrum's defaults; there is no telemetry. Sharing happens explicitly, through a pack or a pull request to Foedrum.
- Foedrum never writes into a repository's own instruction files (`CLAUDE.md` and similar): those are loaded in full on every run, while house yeast is selected and budgeted.

### Format
- **One Markdown file per rule** with JSON frontmatter ([ADR 0007](0007-jsonc-config-and-json-frontmatter.md)): `id`, `scope` (globs, language, optional lens), `kind` (structural or semantic), `source` (the review or comment that produced it), `created`, `status` (`active`, `retired`). The body is the rule in one or two sentences, optionally with a short example.
- One file per rule keeps diffs, reviews and curation per rule, and avoids merge conflicts between batches.
- Usage counters (selected, violated) are not committed with the rule; they live in the event store, so using a rule never creates a commit.

### From lesson to rule
- A **candidate** is recorded, as an event on the state branch, when a review finding required a fix (the Cooper changed code for it) or a human review comment on a bottle asked for a change.
- A candidate is **proposed as a rule** when the same lesson recurs (default: a second occurrence) or when a human asks for it (`/foedrum remember` on the comment).
- **A human always approves a rule** in 1.0: repository-layer rules in the bottle, Brewery-layer rules by pull request to the Brewery. There is no automatic acceptance.

### Foedrum's own development
Foedrum dogfoods the repository layer: the review skill for Foedrum's own pull requests proposes rules into `.foedrum/house-yeast/` of the Foedrum repository, in the pull request it reviews. The format and selection are proven on Foedrum's own code before they ship.

## Consequences
- Knowledge about a repository lives with that repository and goes through its normal review.
- Target repositories receive a small `.foedrum/house-yeast/` directory; repositories that refuse it use the Brewery fallback.
- Rule files in a target repository are untrusted input, so selection treats them as data.
- The Brewery's `.foedrum/` (local state) and a target repository's `.foedrum/house-yeast/` (committed rules) share a directory name; Foedrum never writes local state into target repositories, and a repository that is also a Brewery ignores `.foedrum/*` except `house-yeast/`.

## Alternatives considered
- **Everything in the Brewery (ADR 0015 as written):** one place, but rules drift away from the code and the repository's owners never see them.
- **Everything in the repositories:** organisation-wide conventions would be copied into every repository.
- **Writing rules into the repository's `CLAUDE.md`:** visible to every tool, but loaded in full on every run, unbudgeted, and owned by the repository's developers.
- **Automatic acceptance after N confirmations:** less review work, but an unreviewed rule steers every later batch.
- **One file per scope:** fewer files, but merge conflicts between parallel batches and coarse-grained reviews.
