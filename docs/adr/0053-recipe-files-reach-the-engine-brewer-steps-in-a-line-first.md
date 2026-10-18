# 0053. Recipe files reach the engine: brewer steps in a line first, and all or nothing

Date: 2026-10-16 · Status: Accepted, amended by [0064](0064-test-first-recipes-when-onblocked-and-a-red-proof-required.md) (a red proof required instead of the test-first refusal; `when` and `onBlocked`) and [0069](0069-check-steps-run-the-repositorys-commands-in-an-attempt-of-their-own.md) (check steps load) · Amends [0025](0025-batch-lifecycle-stuck-reminders-and-rewind.md)

## Context
`decide` asks a recipe where a batch goes next through the `Recipes` interface (`src/engine/recipes.ts`, ADR 0025): the first step, whether a step exists, each step's deadline and stall limit, what follows a step, whether a step gets another attempt, and where a failed check or a findings blocker goes back to. Only the test fake implemented it, so the CLI passed an empty one and `retry`, `skip`, `answer`, `recipe` and `rewind` were refused with "the Brewery has no recipe …" (#126). `foedrum serve` (#148) needs the real one too.

The recipe schema (`src/schemas/recipe.ts`) describes much more than the engine runs today. `decide` and the driver know one kind of work: an attempt that a brewer runner runs. A check step, a loop, a parallel group, a session step, a human gate, an action or a fan-out started on the brewer runner would be run as a brewer, which it is not; a `when` needs a "skipped" record the event log does not have yet; an `onBlocked` route needs the rounds it used, which the folded state does not keep apart from retries.

## Decision
- **Where the files are.** The Brewery's recipes are `recipes/<name>.jsonc` and its brewers `brewers/<name>.md`, directly in those folders of the Brewery's root (brewers-and-recipes §1 and §3). Other files and subfolders are not read. A file must hold the recipe or brewer it is named after.
- **All or nothing.** `loadRecipes` (`src/engine/recipe-files.ts`, the core) checks every file and returns either every recipe or every problem, one line each, starting with the file: a file that cannot be read, one that does not pass its schema (as one line), one not named after what it holds, a recipe that names a brewer the Brewery has no file for, a step the engine does not brew yet, or a test-first recipe. A brewer whose file is there but broken is reported once, as that file. Nothing is half loaded: a Brewery with one broken file has no recipes until it is fixed. `readBreweryFiles` (`src/engine/brewery-files.ts`, the shell) reads the files; a folder or file it cannot read is listed with the reason, so it fails the load too.
- **Brewer steps in a line, first.** A recipe loads when each of its top-level steps is a brewer step without `when`, `onBlocked`, `lens` or `blocking`, and with a deadline (its own or its brewer's) of at most 365 days: the `Duration` schema has no upper bound, and a deadline past what a time can hold would throw when the step is scheduled, naming no file. Its `Recipe`:
  - starts with its first step and goes from step to step; after the last it is done, with no pull request (the `openPullRequest` action comes later);
  - gives each step its own `deadline`, else its brewer's;
  - gives each step its brewer's `stall`, or none;
  - retries a step while it has had fewer attempts than its brewer's `maxAttempts`. Attempts are counted over the batch's whole life, as the fake does, so a human `retry` after the attempts ran out gives the step one more;
  - has no route back.

  Any other step fails the load with `step "<id>" is a <kind> step, which the engine does not brew yet (ADR 0053)`, or `has a "when"` / `has an "onBlocked" route` / `has a "lens"` / `has "blocking"`, `which the engine does not follow yet`: a Taster would run without its lens, and Brett's survivors would never block. Each kind joins with the issue that teaches the engine to run it, and takes its line out. `match` and `budget` load but do nothing yet: the router and the budget are not built.
- **Resolved, and not test-first yet.** Once its steps load, each recipe goes through `resolveRecipe` (`src/engine/resolve-recipe.ts`), which fulfils ADR 0028's "the recipe loader must" call it: nothing reads `testFirst` from the file directly. A recipe that resolves to test-first (its own `testFirst: true`, or none with a brewer that produces `commits`) fails the load with `it is a test-first recipe, which the engine does not brew yet: set testFirst: false until test-first recipes land (#25) (ADR 0053)`. Loaded, it would brew without its Gauger and red proof (ADR 0017), as something it is not. #25 takes the line out.
- **One line, said by doctor and by a refused command.** `foedrum doctor` reads the files in the working directory and reports the problems as a required one: `the Brewery's recipes are not valid (required): <problem>; <problem>`. A command that needs recipes loads them when it runs (`CliContext.recipes` is a loader, so a read-only command never reads them) and is refused, with exit 1 and nothing appended, with the same text: `foedrum retry: the Brewery's recipes are not valid: <problem>; <problem>` (`invalidRecipes`). `foedrum serve` will stop with it (#148).

## Consequences
- A Brewery can brew a recipe of brewer steps from its own files; recipes with checks, loops or actions are refused by name until the engine runs them, instead of being run as something they are not.
- Until #25, a recipe with a brewer that produces `commits` loads only with `testFirst: false`, which says in the file that it brews without a red proof.
- One broken file stops every command that needs recipes, also for batches whose recipe is fine. That is the price of never brewing against a half-read Brewery; doctor names every problem at once.
- The `Stall` fields of the `Recipes` interface may be `undefined`, as a brewer's frontmatter has them.

## Alternatives considered
- **Load the valid files and skip the others.** A batch whose recipe is broken would then be refused with "the Brewery has no recipe", which hides the real problem, and a recipe could brew with a brewer whose file was skipped.
- **Load every recipe and refuse only the unbrewable ones.** `find` would answer `undefined` for them, which `decide` reads as "no such recipe": the wrong message, and the router could still pick one.
- **Run every step kind on the brewer runner for now.** A check or an action is not a brewer; running it as one would spend tokens and record outcomes that mean nothing.
- **Default recipes under `defaults/`.** There are none yet; when there are, they load through the same function, next to the Brewery's.
