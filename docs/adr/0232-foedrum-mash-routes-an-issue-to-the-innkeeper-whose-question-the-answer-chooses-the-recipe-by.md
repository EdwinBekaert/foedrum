# 0232. foedrum mash routes an issue to the Innkeeper, whose question the answer chooses the recipe by

Date: 2026-10-28 · Status: Accepted · Narrows #388 (its 2026-10-26 decision: the first step suggests a recipe and asks) and #405 (its `mash` item) · Amends [0006](0006-no-mid-run-questions.md), [0019](0019-interactive-sessions-and-one-command-layer.md), [0025](0025-batch-lifecycle-stuck-reminders-and-rewind.md) and [0118](0118-retrymode-resume-loads-and-an-answer-resumes-the-session-that-asked.md) (the answer to a step that chooses the recipe starts the chosen recipe instead of resuming the step, and `batch.recipe_chosen` gains `askedBy`)

## Context
An order gets its recipe from its Brewery issue's one `recipe:<name>` label, read only while it is Ordered ([ADR 0068](0068-the-intake-in-foedrum-serve-brewery-orders-and-routing-by-label.md), [ADR 0156](0156-a-claimed-order-is-routed-by-its-brewery-issue-s-recipe-label.md)); without one it waits for the routing deadline and goes Stuck on routing ([ADR 0032](0032-routing-deadline-for-ordered-batches.md)).
Nothing helps the engineer choose a recipe for an issue whose description is still broad: there is no `mash` command, and `defaults/brewers/` has no brewer that reads an issue and suggests one.
#388 decided on 2026-10-26 that mash is started by the engineer, and that its first step suggests a recipe and asks; #373 was split into #584 to #592, and this record is #584's.
On 2026-10-27 the maintainer decided that the step is a recipe of its own, `mash-in`, and that its brewer, the Innkeeper, runs on the `builder` alias.

Four facts shaped it.
`batch.recipe_chosen` already records a choice by `label`, `router` or `human`, a human's with `by` and `via`, and `foedrum recipe` restarts a batch on another recipe from its first step ([ADR 0025](0025-batch-lifecycle-stuck-reminders-and-rewind.md)).
A `needs_input` out doc makes the batch Stuck with its questions, and an answer resumes the session that asked ([ADR 0006](0006-no-mid-run-questions.md), [ADR 0118](0118-retrymode-resume-loads-and-an-answer-resumes-the-session-that-asked.md)).
An out doc's frontmatter is read against a schema the engine can build from what the step allows, and an invalid one fails the attempt retryably with the reason, as `tastingOutDocOf` builds one from a step's lenses ([ADR 0161](0161-lens-steps-run-a-taster-whose-findings-are-advisory-unless-the-step-blocks.md), [ADR 0220](0220-a-taster-s-step-can-run-several-lenses-together.md)).
And a label on the Brewery issue is an effect through the ledger, found on the issue before it is applied, as the lane labels are ([ADR 0154](0154-lane-labels-on-the-order-s-issue-and-the-status-comment-s-path-line.md)).

## Decision

### Only `foedrum mash` mashes
- **No order is mashed by itself.** A `recipe:<name>` label routes as today, the intake orders no Brewery issue without one, and an Ordered batch nobody routes still goes Stuck on routing at its deadline (ADR 0068 and ADR 0032 stay as they are).
- **`foedrum mash <issue>` is the only way in**, and `/foedrum:mash <issue>` runs it.

Rejected: routing every unlabelled order to `mash-in` (#388 before 2026-10-26): a model call for every issue nobody asked about.

### The recipe
- **`defaults/recipes/mash-in.jsonc`**, one step, `innkeep`, the Innkeeper's, with `"chooses": "recipe"`, and no pull request: nothing it does commits.
  Mashing in is the first step of a mash (decided with the maintainer, 2026-10-27); nobody types `recipe:mash-in`, and `foedrum mash` routes to it.
- **A step's `chooses: "recipe"`** says that the answer to its question chooses the batch's recipe; the loader allows it only on a step whose brewer answers with the `recipeChoice` schema, and requires it there, since a question nobody acts on would leave the batch Stuck after its answer.
  The loaded recipe answers `choosesRecipe(stepId)`, which is how `decide` knows the step.

Rejected: the engine knowing the name `mash-in` (a Brewery's own recipe could not ask the same way); the brewer's schema alone marking the step (`decide` sees recipes, not brewers, and the step is where a recipe says what follows it).

### The Innkeeper
- **`defaults/brewers/innkeeper.md`**, read-only as the Taster is (`Read`, `Grep`, `Glob`, and `Edit` of its out doc only, `access: "read"`, `tree: "task"`), on `builder` (decided with the maintainer, 2026-10-27), `effort: "low"`, `maxTurns: 30`, a `deadline` of `10m`, `maxAttempts: 2`.
- **It reads the issue (`{order}`) and the repository its attempt runs in**, and asks exactly one question: which recipe brews the issue, `recommended` its suggestion, and the reason in the question's text, for example "Which recipe brews #12? Suggested: decoction: it touches three areas and a credential."
- **Its attempt runs where every attempt of the batch runs** (`repositoryOf`, [ADR 0063](0063-foedrum-serve-its-configuration-and-wiring.md)): a claimed issue's repository, or the Brewery's only one for a Brewery issue; in a Brewery of several repositories a Brewery issue's attempt fails with `repositoryOf`'s reason, as any Brewery order's does today.
  Reading the other repositories an issue names is left to a later change: #586's `from: "repositories"` input names the Brewery's repositories, but an attempt reads only its own worktree.
- **Its choices are the Brewery's recipes**, but those with a step that chooses a recipe: `mash` (a quick plan, #586), and `decoction` (a deep plan) once #587 adds it, or a building recipe such as `nip` when the issue is small and clear.
  A recipe the Brewery does not have is never offered.
- **It learns them from an input the engine builds**, a new input source `from: "recipes"`: one line per choice, `- <name>: <description>`, in the order the loader read them, between nonce tags as every input is ([ADR 0041](0041-untrusted-input-in-per-prompt-nonce-tags.md)).
  Any brewer may name it: the Innkeeper offers its recipes, and #586's Brewmaster names them for a plan's sub-orders (ADR 0234: the second of the two to merge adds it).
  An input the engine fills is declared in the brewer's frontmatter as a source of its own, never handed to a brewer by its name; #586's `from: "repositories"` follows the same pattern (decided by the consultant).
- **The engine holds it to them with the `recipeChoice` schema**, built per step from those names (`recipeChoiceOutDocOf`), as `tastingOutDocOf` is from lenses: `needs_input` with exactly one question, whose options are among the choices; `blocked` and `failed` as for any brewer.
  A `done`, a second question, or an option the Brewery lacks fails the attempt retryably, the reason naming it, and its retry asks again.
- **A Brewery with fewer than two choices has nothing to choose**: `foedrum mash` refuses with a line that names the one recipe's label and says that `decoction` comes with #587, since a question needs two options ([ADR 0006](0006-no-mid-run-questions.md)).

Rejected: the Innkeeper reading the Brewery's recipe files (its worktree is the target repository's, which does not hold them); a list in its prompt (it would offer recipes a Brewery lacks); an out doc schema that accepts any name and a check in `decide` (the attempt would end and the batch go Stuck on a question that cannot be answered, where a retry can still ask a good one).

### How the answer chooses
- **The engine reads the choice from the answer itself.** `answer` on the question of a step that `choosesRecipe` appends `input.received`, `batch.recipe_chosen` with `source: "human"`, the answer's `by` and `via`, `askedBy` (the step), and a reason that says whether the suggestion was taken (`the answer at innkeep: nip, as suggested`, or `the answer at innkeep: nip, not the suggested decoction`), then `batch.resumed` with `action: "answer"`, and enters the chosen recipe's first step, as the `recipe` command does.
  The Innkeeper's session is not resumed: its job ended with the question, and the answer is the whole result, so another turn would spend tokens to repeat it.
- **An answer that is not one of the question's options is refused** with a line that names them, so the batch stays Stuck with the same question: asked again, never guessed.
  So is a choice the Brewery no longer has, with `decide`'s line for an unknown recipe.

Rejected: reading the choice from the resumed session's out doc (one more model turn and its tokens, and the model could write a recipe nobody picked).

### The label
- **`recipe:<name>` goes on the order's Brewery issue**, a claimed order's included (`breweryIssueOf`), set once through the ledger, `[batchId, "recipe-label"]`, as the lane labels are: found when the issue already shows it and no other, made in the Brewery when it is missing, then added; the issue's other `recipe:*` labels, in any case, come off, so its next order has one label to route by.
- **Only for a choice made by answering a step that chooses**, the `batch.recipe_chosen` with `askedBy`; a choice by `foedrum recipe` labels nothing (#592 decides that one).
  A later choice in the same batch labels nothing more: the key is applied once.
- **A label added after routing changes nothing** (ADR 0068): it routes the issue's next batch, ordered again, and never this one.

### `foedrum mash <issue>`
- **`<issue>` is a Brewery issue `#n`**, a claimed order's Brewery issue included (`claimOfOrder`), whose batch is the claimed issue's.
- **It orders the issue when it has no batch yet**, as `foedrum brew` does, and routes an Ordered or routing-Stuck batch to `mash-in` with the `recipe` command (`batch.recipe_chosen`, `source: "human"`, `the engineer ran foedrum mash`).
  A batch that already started a recipe is refused with a line that names `foedrum recipe`; a batch on tap or cancelled with the line that names `foedrum order`, as `brew` refuses it.
- **It then drives the batch to its question as `foedrum brew` does**, on brew's driver, so one command asks: it ends with the question and the `foedrum answer` line, exit 4 (needs input).
- **`/foedrum:mash`** runs it, asks the question with AskUserQuestion, its options as choices and the suggestion marked, answers through `foedrum answer`, and runs `foedrum brew` on the chosen recipe if the engineer wants it brewed now.
- **Questions as everywhere**: `foedrum brew` and the plugin ask live, `foedrum stuck` and `foedrum answer` later.

Rejected: `foedrum mash` routing only, and `foedrum brew` asking afterwards (two commands for one question); the plugin answering by itself (an answer is the engineer's).

## Consequences
- An engineer gets a recipe suggested for a broad issue in one command, and the label on the issue records the choice for the next order of it.
- `decide`'s `answer` has one more branch, keyed on the recipe's step; every other answer resumes the session that asked, as before.
- `batch.recipe_chosen` gains `askedBy`, optional, so a choice without it reads as before; an older Foedrum cannot read a log with it (as [ADR 0191](0191-the-step-a-findings-route-goes-back-to-records-a-disposition-for-each-finding.md) records for dispositions).
- Foedrum's defaults offer the Innkeeper `mash` (#586) and `nip`, and `decoction` once #587 adds it.
- #592 decides whether `foedrum recipe` labels the issue too; reading the other repositories an issue names is left to a later change.
