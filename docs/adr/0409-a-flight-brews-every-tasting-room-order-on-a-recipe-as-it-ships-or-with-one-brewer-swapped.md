# 0409. A Flight brews every tasting-room order on a recipe as it ships, or with one brewer swapped

Date: 2026-11-16 · Status: Accepted · Amends [0404](0404-the-flight-s-tasting-room-is-a-folder-of-orders-each-proved-by-its-hidden-tests.md) (the runner it left to #1083: what it brews, what it records, and the dry run's open question answered by reading)

## Context
ADR 0404 made the tasting room: orders with hidden tests, proved fair, which nothing brews.
`scripts/tasting-compare.ts` brews on the fake code host through a harness of its own, `scripts/tasting-compare/harness.ts` (#1100), but always scripts one step, and its targets are this repository's own heads.
A model-upgrade pull request changes one brewer's level in a recipe; to judge it, the Flight has to brew the recipe as it ships and the same recipe with that one brewer moved.

## Decision
- **`node scripts/flight.ts --recipe <name> [--brewer <name> --model <level or id> --effort <effort>] [--runs <n>] [--dry-run]`**, by hand only, brews every order of the tasting room `--runs` times (3 by default) through the comparison's harness, with no step scripted, on the real claude.
  Its options and every refusal go through one tested function, `flightOptionsOf` in `scripts/flight/core.ts`; a refusal exits 2.
  The recipe is a default recipe by its name.
- **Decided with the maintainer on 2026-11-16: the recipe as it ships, with one brewer swapped.**
  - Without `--brewer`, the scratch Brewery holds no recipe copy and no `models.jsonc`: the recipe brews as it ships, and `--model` or `--effort` alone is refused.
  - With `--brewer`, all three are required, and a brewer no step of the recipe names is refused.
    The scratch Brewery gets a copy of the default recipe in which only that brewer's steps, children of a parallel group included, name the model and the effort.
  - A level is used as given.
    A model id needs a level of its own, since a level is shared Brewery-wide: the swapped steps borrow the first level, in the order light, standard, strong, extreme, that no other step of the recipe names, and `models.jsonc` maps only that level to the id; `strong` for nip, `extreme` for deep-brew, whose `taste` step stays on `strong`.
    A recipe whose other steps name every level is refused with a model id.
  - The reason: a model-upgrade pull request moves one brewer, so the Flight measures exactly that against the recipe as it ships ([evaluation](../design/evaluation.md)'s `--brewer`).
- **A run's target is its order's starting tree** (`startingTree`) on the scratch remote, and its issue the order's `order.md`; the hidden tests stay out of it.
  The target's only check is `node --test`, with a TAP report for the Maltster's test map to name; the bases have no dependencies, so no setup runs.
- **After each batch**, the runner clones the scratch remote, checks out the head a person gets from the batch, lays the order's hidden tests over it (`withLayer`), and runs them with `node --test` on their files, 120 seconds at most, as the proof does.
  The head is the batch's pull request's latest push, or, with no pull request, the commit the green step read last; `headFrom` records which.
- **Each run's record**, one line of `results.jsonl`, holds how the batch ended, the head and `headFrom`, whether the hidden tests passed, failed or timed out and the end of their output, the files changed from the base, those outside the order's `allowedPaths`, each step's attempts, tokens, turns and time (`stepRunsOf`), and the models each brewer step's transcripts name.
  - An `allowedPaths` entry that ends in `/` holds the files under that folder, never a sibling whose name starts with it; any other entry holds only that one file.
  - `.foedrum/test-map.jsonc` is never outside: the Maltster of a test-first recipe commits it, and it is Foedrum's file, not the order's.
  - A run with no head measured nothing and is brewed once more; a run whose hidden tests failed measured the code all the same.
- **A run on a model it did not ask for stops the Flight**, as ADR 0394's brewer runs do (`isAsked`): a swapped brewer's steps ask for what `--model` asked, a level's family or the id; every other step asks for its own level's family, so a Flight of the recipe as it ships stops on a model it did not ask for too.
  So does a transcript that cannot be found, or one of a succeeded attempt that names no model.
- **The records** go under `.foedrum/tmp/flight/<recipe>`, or `<recipe>-<brewer>-<model>-<effort>` with a swap, and a `dry-run` folder under it for a dry run; a stopped Flight goes on where it stopped, as the comparison does.
  `table.md` gives each order's runs, hidden tests passed, runs with changes outside its paths, tokens and the brewers' time; when #1084 comes, it will compare two Flights from the records.
- **`--dry-run` scripts every brewer and skips the recipe's test-first steps**: its recipe copy sets `testFirst` off, its Cellarman commits the order's whole reference solution, its Finer simplifies nothing and its Tasters approve.
  Those steps are the engine's and are tested there; the dry run proves the Flight's own machinery: the target, the batch on the fake code host, the head, the hidden tests and the record.
  A first dry run that kept them was refused at the red proof, the solution's tests importing names the base does not export yet ("the run has a load, compile, import or collection error"), and the solution's changes to existing tests can only be in the Gauger's commit (ADR 0358).
  Its header line says that a dry run skips the test-first steps and that a real Flight runs them.
- **Whether a brewer's file tools reach `tasting-room/`** (ADR 0404's open point), read, not ran: a brewer runs with `--permission-mode dontAsk` (`src/brewers/claude-command.ts`), and its attempt settings scope every bare file-tool rule to `./**`, its worktree (`scopedRule` in `src/schemas/attempt-settings.ts`, ADR 0093), so a Read, Grep or Glob of `tasting-room/`, outside the scratch worktree under `.foedrum/tmp/flight/`, matches no allow rule and is denied.
  A dry run cannot show it, since the scripted brewers start no claude and write no settings; the maintainer's first real Flight confirms it from one attempt's settings file.

### A Brewery's files
None: this is a development script of Foedrum's own repository, run by hand in scratch folders, and nothing in a Brewery changes, so no Brewery needs a migration.

## Consequences
- A recipe or model change is judged by a command line: a Flight of the recipe as it ships, and one with the brewer swapped, each 3 runs of 10 orders, 30 batches.
- A Flight spends a whole recipe's tokens on each run; its cost is in its records, never in money.
- The dry run shows nothing of the test-first steps; they are judged by a real Flight.

## Alternatives considered
- **Every step on the given model and effort:** it would measure a recipe no Brewery runs, not the change a model-upgrade pull request makes.
- **`modelsFileOf`'s `strong` for a model id:** a recipe whose other steps name `strong`, as deep-brew's Taster does, would move them too.
- **A test-first dry run whose Gauger commits a generated test of the solution's exports:** an export parser for a dry run, whose Gauger then differs from a real one, while the steps it would show are the engine's.
- **A mode of `tasting-compare.ts`:** its modes rebrew this repository's heads; the Flight's orders, record and hidden tests are its own, and it shares the harness, not the script.
