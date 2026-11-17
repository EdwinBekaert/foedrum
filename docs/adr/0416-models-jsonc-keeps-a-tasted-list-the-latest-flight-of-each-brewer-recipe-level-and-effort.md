# 0416. models.jsonc keeps a tasted list: the latest Flight of each brewer, recipe, level and effort

Date: 2026-11-17 · Status: Accepted · Amends [0153](0153-foedrum-s-defaults-map-their-own-model-aliases.md) (the merge also keys tasted entries by their combination), [0397](0397-recipe-steps-name-a-model-level-and-an-effort-of-foedrum-s-own-which-models-jsonc-translates-for-the-agent.md) (the `claude` block gains a `tasted` list, merged by its combination), [0409](0409-a-flight-brews-every-tasting-room-order-on-a-recipe-as-it-ships-or-with-one-brewer-swapped.md) (a dry run's record says it is one) and [0411](0411-a-flight-report-calls-equal-passes-the-same-and-counts-a-run-that-measured-nothing-as-not-passed.md) (the report writes the entry and a pull request description)

## Context
A Flight records the exact model id each brewer step's transcripts name ([ADR 0409](0409-a-flight-brews-every-tasting-room-order-on-a-recipe-as-it-ships-or-with-one-brewer-swapped.md)), and the Flight report compares two Flights ([ADR 0411](0411-a-flight-report-calls-equal-passes-the-same-and-counts-a-run-that-measured-nothing-as-not-passed.md)).
Both write only under `.foedrum/tmp/flight/`, which is deleted after two days ([ADR 0389](0389-nothing-in-foedrum-tmp-is-kept-and-the-worktree-cleanup-clears-it.md)).
Nothing kept which model, at which level and effort, was tasted for which brewer, with what result.
`models.jsonc` names levels by Claude Code's short names (`"strong": "opus"`), which move to each new version on their own, so a Brewery can run on a model nobody has tasted.
Decided with the maintainer on 2026-11-17 (#1141), in place of a model watcher (#1085).

## Decision
- **The `claude` block of `models.jsonc` holds a `tasted` list beside `models` and `efforts`**: one entry per brewer, recipe, level and effort, the latest tasting of that combination, won or lost.
  A newer tasting of the same combination replaces its entry; the history stays in git and in the pull request that added each entry, so there is no archive.
  The list is in the `claude` block because its model ids are claude's, as ADR 0397 keeps one block per agent.
- **An entry's fields** (decided with the maintainer on 2026-11-17):

  ```jsonc
  { "brewer": "cellarman", "recipe": "nip", "level": "strong", "effort": "larger",
    "model": "claude-opus-5-5", "passed": 9, "runs": 10,
    "baseline": { "passed": 8, "runs": 10, "model": "claude-opus-5" },
    "tokensPerOrder": 412000, "date": "2026-11-20",
    "report": "https://github.com/<owner>/<repo>/pull/<n>" }
  ```

  - `level` and `effort` are Foedrum's own words (ADR 0397), not Claude Code's, so the combination does not depend on the agent.
  - `model` is the exact id the candidate Flight's transcripts named for the brewer's steps, never a family; `baseline.model` the same of the baseline Flight.
  - `passed` is the orders the candidate passed in every run, and `runs` the orders both Flights measured: the summary line's counts (ADR 0411), not the runs brewed. `baseline` holds the baseline's two.
  - `tokensPerOrder` is the candidate's tokens per run, summed over the orders both measured, divided by those orders and rounded, as the summary compares them.
  - `date` is the day the report wrote the entry, in UTC.
  - `report` is the link to the pull request that holds the full report, and is optional: the report script opens no pull request, so it cannot know the link, and whoever opens it adds the link in a second commit.
  - Per-order results and verdicts stay in the report, not in the entry.
  - A file with two entries of one combination is refused, with a line naming it.
- **A Brewery's `tasted` merges over Foedrum's by the combination**, as `models` and `efforts` merge level by level and effort by effort ([ADR 0153](0153-foedrum-s-defaults-map-their-own-model-aliases.md), ADR 0397): a Brewery entry takes the place of the default of its combination, and its other entries follow Foedrum's (`mergedModels`, `src/cli/serve-config.ts`).
  Nothing reads the merged list yet; `foedrum taste` (#1143) will.
- **A dry run's Flight record says it is one** (`dryRun: true`), since its scripted transcripts name the models as planned and would otherwise give an entry.
- **The Flight report writes the entry of a real Flight, with no option** (decided with the maintainer on 2026-11-17).
  When the candidate swapped a brewer, both Flights brewed the same default recipe, and each Flight's steps of that brewer named exactly one model id, `scripts/flight-report.ts` adds the entry, or replaces the one of its combination, in `defaults/models.jsonc` in the working copy.
  Its level is the one the swapped steps ran on: `--model` when it is a level, otherwise the level the Flight borrowed for the id (ADR 0409); its effort is the swap's.
  It writes `pull-request.md` beside `report.md` and prints the pull request's title and description: a "How it works" section with what the pull request adds or replaces and both Flights in one line, the report, and a last line that asks for the link in `report`.
  It does not branch, commit, push or open the pull request: a person or a session does that the usual way.
  It never changes `claude.models`: moving a level to the tasted model is the person's choice, made by hand in the same pull request when they make it, since the issue leaves that choice to them and the maintainer settled on a report with no option.
- **When no entry is written, the report says why in one line and leaves `defaults/models.jsonc` as it is.**
  A dry run of either Flight ends with exit 0, since nothing went wrong.
  A candidate as it ships, two Flights of different recipes, a recipe that is no default recipe, no order measured by both, or steps that named two model ids or none end with exit 1.
- **`defaults/models.jsonc` is written whole**: its leading comment lines as they are, and the rest as the parsed file with the entry in place, in the shape Biome formats JSON in; a comment past the header would be dropped, and the pull request's diff would show it.
  Foedrum parses JSONC itself and has no writer that keeps comments, and the default file has only its header.

### A Brewery's files
None until the first publish: a Brewery's own `models.jsonc` without a `tasted` list keeps working, its list empty.

## Consequences
- What a level runs on can be read against what was tasted: the exact id, its result and its baseline.
- Each model-upgrade pull request on Foedrum carries its Flight's entry and report.
- A Brewery cannot yet taste for itself: when `foedrum taste` (#1143) comes, it will record into the Brewery's own `models.jsonc` and open the pull request through the engine's own push and pull request path.

## Alternatives considered
- **The list at the top level of `models.jsonc`:** its ids are one agent's, which the `claude` block already holds.
- **Claude Code's effort words in the entry:** the combination would change with the agent while the step's own words do not.
- **A required `--pull-request <url>` option for the link:** the report runs before the pull request exists, and the maintainer settled on no option.
- **The report opens the pull request:** a development script would branch and push on its own; #1143 brings that through the engine.
- **An archive of every tasting:** git and the pull requests keep the history already.
- **Editing the file in place, keeping every comment:** a JSONC writer of Foedrum's own for one file whose only comment is its header.
