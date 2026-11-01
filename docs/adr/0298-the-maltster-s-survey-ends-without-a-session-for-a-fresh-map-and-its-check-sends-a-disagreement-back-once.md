# 0298. The Maltster's survey ends without a session for a fresh map, and its check sends a disagreement back once

Date: 2026-11-01 · Status: Accepted · Amends [0282](0282-a-stale-test-map-sends-back-the-change-that-made-it-and-the-maltster-surveys-a-new-one.md) (how the survey runs only when needed, what keeps it to the test map, and how its map is checked against one run), [0064](0064-test-first-recipes-when-onblocked-and-a-red-proof-required.md) (a check step's `of` names a survey too), [0078](0078-the-red-proof-reads-the-test-report-and-testsunchanged-compares-lines.md) (a test-first batch in a repository that keeps its test map no longer needs `testReport` before its first step), [0274](0274-the-red-proof-reads-line-coverage-of-the-change-and-a-test-map-not-test-names.md) and [0280](0280-a-new-module-is-judged-unreached-only-on-a-passing-test-run.md) (on a survey's check, a module no line reaches and a map stale by the run fail the step back to the survey), [0059](0059-attempt-plans-from-the-brewer-of-the-step.md) (one more guard the loader accepts, `testMapOnly`) and [0225](0225-a-ready-pull-request-gets-a-merge-brief.md) (the merge brief says why the test map changed)

## Context
[ADR 0282](0282-a-stale-test-map-sends-back-the-change-that-made-it-and-the-maltster-surveys-a-new-one.md) decides that the Maltster, a new default brewer, proposes a repository's test map in a `survey` step at the head of the test-first recipes.
The step runs only when the effective map is missing or stale by manifests, "a condition the engine evaluates before the step"; its guards let it write `.foedrum/test-map.jsonc` only; the engine checks its map against one run before the Gauger starts, and the batch is Stuck (`environment`) when no proposed map agrees with a run.
#708 builds it, and found that the recipe vocabulary cannot say three of those things.

- A step's `when` reads the recipe's settings only ([ADR 0064](0064-test-first-recipes-when-onblocked-and-a-red-proof-required.md)): it cannot see whether the repository has a map, or whether it is fresh.
- The guards a brewer may name are `requiresOutDoc`, `requiresCommits` and `testsUnchanged` that the engine enforces, and three it refuses as not followed (`testsNotRemoved`, `scope`, `diffLimits`); none limits which files a brewer's commits change.
- A check step's `of` names the step whose tests a red proof proves, and only a check that expects a fail has one. A route whose rounds run out makes the batch Stuck as `attempts_exhausted`, naming the last reason, not `environment`.

The skip at green of #727 ([#742](https://github.com/EdwinBekaert/foedrum/pull/742)) was considered for the first: it is a skipped *test* that the green check reads in a report, not a brewer step that ends without a session, so it does not fit.

## Decision

### The survey ends without a session when the map is fresh, or the Brewery's
- Before a survey's session starts, a wrapper around the brewer runner (`surveyed`, `src/checks/survey.ts`) reads the test map at the commit the attempt's worktree starts at, and its manifests in the worktree with `manifestFreshness`.
- A step is a survey when its brewer answers with the out doc schema `survey` (the default Maltster's), as a Taster is a brewer whose schema is `tasting` ([ADR 0161](0161-lens-steps-run-a-taster-whose-findings-are-advisory-unless-the-step-blocks.md)).
- **A fresh map**: the attempt ends `succeeded`, with no session and no tokens, with the out doc `{ "status": "done", "map": "fresh" }` and a one-line summary, which the store keeps as any out doc ([ADR 0103](0103-out-docs-reach-the-state-branch-through-the-store.md)).
- **A map the Brewery keeps** (`"testMap": "brewery"`), whether it has one or not: the same, with `"map": "brewery"`, since a survey cannot write the Brewery ([ADR 0282](0282-a-stale-test-map-sends-back-the-change-that-made-it-and-the-maltster-surveys-a-new-one.md)); the map is not even read.
- **No map, one that cannot be read, or one stale by manifests**: the Maltster's session runs.
- **An attempt a route scheduled**, such as the survey check's route back: the Maltster's session runs, whatever its worktree holds, since that is the map that disagreed, fresh by its own manifests, and the route gives it the reason ([ADR 0128](0128-an-attempt-a-route-schedules-gets-what-sent-it-back.md)).
- **Manifests git cannot list**: the attempt is blocked on its environment, naming git's last line.
- No event is new and `decide` stays pure: the step is scheduled, started and finished as every brewer step is, and the status comment's path shows `survey #1 ✅`.
- A survey's out doc says why its map is as it is: `new` (no map, or one that could not be read) or `stale`, with up to 10 stale paths, each one line of at most 1,000 characters, which the Maltster writes; `fresh` and `brewery`, which only the engine writes. A survey whose session ends with `fresh` or `brewery` fails retryably, since those skip its check.

### `testMapOnly` keeps the Maltster to the test map
- A new guard, `testMapOnly`: after a succeeded attempt of a brewer that names it, the same wrapper lists the files the attempt's commits changed, from where its worktree started to its attempt branch, with `git diff --name-only -z --no-renames` in the clone; any file but `.foedrum/test-map.jsonc` fails the attempt retryably, naming up to 10 of them.
- A git read that fails blocks the attempt on its environment.
- The default Maltster names `requiresOutDoc`, `requiresCommits` and `testMapOnly`.
- A step whose brewer is a survey and names `testMapOnly` is not a step that commits code for the red proof's order: a test-first recipe may run it before its Gauger. A survey brewer without the guard counts as one that commits code.

### A check step's `of` names the survey whose map it checks
- A check step that expects a pass may have an `of`; the recipe loader accepts it only when it names an earlier step whose brewer answers with the schema `survey`, and when the step's checks include `test`.
- Nip's survey check: `{ "id": "survey-check", "check": "test", "of": "survey", "when": "recipe.testFirst", "onFail": { "goto": "survey", "maxRounds": 1 } }`.
- No other field: the check runner knows the step reads a survey's map from its `of`, and a red proof stays the check that expects a fail.

### The survey check: one run, and a disagreement goes back once
- When the survey's latest success says `fresh` or `brewery`, the check ends `succeeded` without running anything: there is no proposed map to check. The path shows `survey-check ✅`.
- Otherwise it runs as any check step that runs the tests: freshness by manifests first, then the repository's setup and the `test` check, then the after-run rules of [ADR 0274](0274-the-red-proof-reads-line-coverage-of-the-change-and-a-test-map-not-test-names.md), [ADR 0280](0280-a-new-module-is-judged-unreached-only-on-a-passing-test-run.md) and ADR 0282.
- Two of those rules change their ending for this step, since the map they read is the one the survey has just proposed:
  - a module the map lists that wrote no report after a passing run fails the step, instead of making the batch Stuck, with `module "<name>" wrote no test report at <path>`;
  - a map stale by the run fails the step, instead of only being named, with the stale paths and why.
- Every failure of the step that is not retried (those two, a map stale by manifests, a map the tip cannot read, a test check that failed, a base that is not green under the map) is a disagreement: `the test map the survey proposed disagrees with a run of <repository>: <what> (ADR 0298)`, along its `onFail` route back to the survey, whose next attempt gets the reason ([ADR 0128](0128-an-attempt-a-route-schedules-gets-what-sent-it-back.md)).
- **When the route has no round left**, counted as the survey's attempts that this step's route scheduled, the check runner itself ends the step blocked on its environment: `no test map the survey proposed agrees with a run of <repository>: <what> (ADR 0298)`. Route exhaustion in `decide` would make the batch Stuck as `attempts_exhausted`, which reads as a brewer that kept failing; the batch is Stuck because the repository's tests and the map disagree, which a person settles.

### No `testReport` needed before the first step where the survey proposes a map
- A batch of a test-first recipe whose red proof would run no longer stops before its first step for a repository without `testReport`, when the recipe has a survey check that the batch runs and the repository keeps its map: the survey proposes one, and the red proof reads the map.
- Under the Brewery fallback, or in a recipe without a survey, the Stuck start of [ADR 0078](0078-the-red-proof-reads-the-test-report-and-testsunchanged-compares-lines.md) stays, until #747 removes the reading without a map.

### The pull request says why the map changed
- The merge brief, under the sensitive-path line that already names `.foedrum/test-map.jsonc`, adds `The test map of <repository> is new: the Maltster proposed it.` or `The test map of <repository> was stale (<paths>): the Maltster refreshed it.`, from the survey's first out doc that says `new` or `stale`, since a survey its check sent back reads its own proposal as stale; the paths are model text and are escaped.
- Nothing is added for a fresh map, or one the Brewery keeps.

## Consequences
- A test-first batch in a repository with a fresh map pays no tokens for its survey and runs no extra test command: the survey and its check succeed at once.
- A batch in a repository without a map, or with a stale one, pays for one Maltster session and one more run of the test line before the Gauger.
- A repository whose tests do not agree with any map the Maltster proposes is Stuck at its second disagreement, before a Gauger runs, naming what disagreed.
- `npm run demo` and the Nip fixture keep their name-reading red proof: their repository's map is the Brewery's, which has none, so the survey and its check succeed at once and the path gains `survey` and `survey-check`. #750 brews them through a real map.
- The recipe vocabulary has one more meaning of `of` and one more guard, both refused by the loader where they cannot hold.

## Alternatives considered
- **A new engine event that skips the survey**, recorded by the driver after reading the map. It would put a repository read into the decision of what runs next, which ADR 0064 keeps to the recipe's settings, and it would need a new event in the store; the attempt that ends without a session reads the same in the status comment.
- **A `when` that reads the repository** (`repo.testMap == 'fresh'`). `when` is decided by `decide`, a pure fold over events; it would need the read recorded as an event first, as above.
- **Route exhaustion as the Stuck reason**, with no special ending: `attempts_exhausted` names the last reason but reads as a brewer that ran out of tries, and its options (retry) would run the same map against the same tests.
- **A new recipe field on the survey check** (`"surveys": "survey"`) instead of `of`. Two fields that name a step for a check to read would differ only by the step's brewer; `of` with the loader's check says the same.
- **The Gauger proposes the map**, or a rules-based command does: decided against in ADR 0282.
