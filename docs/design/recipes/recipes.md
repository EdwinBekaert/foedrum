# Recipes

A recipe is a JSONC file (`recipes/<name>.jsonc`) with a `$schema` reference for editor autocompletion.
Schema: `src/schemas/recipe.ts` (`schemas/recipe.json`).
Foedrum's own recipes are checked as `DefaultRecipe`, which also rejects literal commands.

```jsonc
{
  "$schema": "../.foedrum/schemas/recipe.json",          // for editors; `foedrum init` writes none yet
  "name": "half-pint",
  "description": "Small feature in one repository",
  "match": { "labels": ["feature"] },
  "testFirst": true,                                         // the router may switch it off, with a reason
  "concurrency": 2,                                          // at most 2 of its batches at once; none by default (ADR 0217)
  "steps": [
    { "id": "plan", "brewer": "brewmaster" },                // writes plan.md
    { "id": "gauge", "brewer": "gauger",                     // failing tests (+ stubs) + commit
      "when": "recipe.testFirst" },
    { "id": "red", "check": "test", "expect": "fail",        // red proof: gauge's tests fail (behaviour missing)
      "of": "gauge", "when": "recipe.testFirst",
      "onFail": { "goto": "gauge", "maxRounds": 1 } },
    { "id": "implement", "brewer": "cellarman",              // code + commits
      "onBlocked": { "findings": { "goto": "gauge", "maxRounds": 1 } } },  // "this test is wrong"
    { "id": "green", "check": ["typecheck", "lint", "test"], // gravity reading, no model tokens
      "onFail": { "goto": "implement", "maxRounds": 2 } },
    { "id": "review", "loop": {                              // review/fix loop
        "maxRounds": 2,
        "until": "tasting.verdict == 'approve'",
        "steps": [
          { "id": "tasting", "parallel": [                   // approve = no blocking child asks for changes
              { "id": "correctness", "brewer": "taster", "lens": "diff/correctness" },
              { "id": "security", "brewer": "taster", "lens": "diff/security" },
              { "id": "test-design", "brewer": "taster", "lens": "diff/test-design" },
              { "id": "mutants", "brewer": "brett" }         // advisory unless "blocking": true
          ] },
          { "id": "fix", "brewer": "cooper", "when": "tasting.verdict != 'approve'" },
          { "id": "recheck", "check": ["typecheck", "lint", "test"],  // the Cooper's commits are measured too
            "when": "tasting.verdict != 'approve'",
            "onFail": { "goto": "fix", "maxRounds": 2 } }
        ]
      },
      "onExhausted": "stuck" },
    { "action": "openPullRequest" }
  ]
}
```

**Loading.** The Brewery's recipe, brewer and lens files load all or nothing (`loadRecipes`, [ADR 0053](../../adr/0053-recipe-files-reach-the-engine-brewer-steps-in-a-line-first.md)), on top of Foedrum's own defaults (`defaults/recipes/`, `defaults/brewers/`, `defaults/lenses/diff/` and `defaults/lenses/plan/` of its install, never of the working directory): a Brewery file replaces the default of the same name whole, every default it keeps loads like its own file, and `foedrum doctor` lists the defaults in use ([ADR 0098](../../adr/0098-foedrum-s-defaults-load-under-the-brewery-s-files-and-a-brewer-input-can-name-a-lens.md)); it also names a Brewery file that replaces a default with the default's headings and marked lines (lines that start with a bold phrase) it no longer has, so a rule a copy dropped shows ([ADR 0141](../../adr/0141-doctor-reports-prompt-sizes-unused-files-and-what-a-brewery-file-drops-from-its-default.md)); `defaults/models.jsonc` is the exception, merged by alias under the Brewery's `models.jsonc` rather than replaced by it ([ADR 0153](../../adr/0153-foedrum-s-defaults-map-their-own-model-aliases.md)).
Beyond that: a file must hold the recipe or brewer it is named after, every brewer a recipe names needs a file, the Brewery's or a default, a lens holds at most 1 MiB, and one file that does not load stops every command that needs recipes with the line `foedrum doctor` gives (`the Brewery's recipes are not valid: <file>: <problem>; …`).
For now the engine brews only brewer steps, with a `lens` and `blocking` on a Taster's step only ([ADR 0161](../../adr/0161-lens-steps-run-a-taster-whose-findings-are-advisory-unless-the-step-blocks.md)), and check steps in a line, with parallel groups of Tasters' lens steps among them ([ADR 0168](../../adr/0168-a-parallel-group-runs-its-lens-steps-side-by-side.md)): a brewer step's deadline is its own or its brewer's, its stall limit and `maxAttempts` are its brewer's, a deadline is at most 365 days, and after the last step the batch is done.

Check steps: [check steps](../checks/check-steps.md).

A failed check follows the step's `onFail` route, at most `maxRounds` times, then makes the batch Stuck; the attempt a route schedules, `onFail`, `onBlocked` or `onPullRequestFail`, gets one more tagged input, `route`: the failed checks with their tails, the reason and out doc of the attempt that blocked, or the checks that failed on the pull request's head with their links and no log, from that round only and at most 64 KiB ([ADR 0128](../../adr/0128-an-attempt-a-route-schedules-gets-what-sent-it-back.md), [ADR 0219](../../adr/0219-a-failing-check-on-an-open-pull-request-sends-its-batch-back-to-a-fix-step.md)); a check the repository maps to `null` is skipped.

A `when` may read the recipe's settings (`recipe.testFirst`) but not yet another step's result, and an `onBlocked` findings route counts its rounds from the attempts it scheduled ([ADR 0064](../../adr/0064-test-first-recipes-when-onblocked-and-a-red-proof-required.md)).
A recipe that resolves to test-first (`resolveRecipe`) needs a red proof whose `of` is its first writing step, with no other writing step before it; otherwise it is refused with a line that names the fix, or `testFirst: false`.
Other step kinds are refused by name until the engine runs them.

A brewer with `retryMode: resume` loads: a retry of its step, and the attempt an answer to its questions starts, continue the session of the attempt before it in the worktree that session ran in, the answer as the one input of the short prompt that tells it to go on, and start fresh, with every round's answers, when that session or worktree cannot be got back ([ADR 0117](../../adr/0117-a-retry-resumes-the-session-of-the-attempt-before-it-in-that-attempt-s-worktree.md), [ADR 0118](../../adr/0118-retrymode-resume-loads-and-an-answer-resumes-the-session-that-asked.md)).
A step whose brewer asks for what the attempt plan does not carry yet is refused by name too: `skills`, `mcp`, `context: repo`, `toolbox`, `doneWhen`, or a guard other than `requiresOutDoc`, `requiresCommits` ([ADR 0074](../../adr/0074-git-commit-grants-fixed-git-rules-and-done-needs-a-commit.md)) and `testsUnchanged` ([ADR 0059](../../adr/0059-attempt-plans-from-the-brewer-of-the-step.md)), or a `tree` other than `task` ([ADR 0066](../../adr/0066-the-task-tree-continues-from-the-latest-succeeded-attempt.md)).
After the last step the batch goes on tap with no pull request, unless the recipe ends with `{ "action": "openPullRequest" }`, the one action that loads: the engine then pushes the task tree to the bottle branch and opens the pull request, which it opens once per batch and pushes to once per round of it ([open pull request](open-pull-request.md), [ADR 0219](../../adr/0219-a-failing-check-on-an-open-pull-request-sends-its-batch-back-to-a-fix-step.md)), and the batch goes on tap only with it ([ADR 0071](../../adr/0071-the-openpullrequest-action-two-effects-of-the-batch.md)).
It must be the last step; the other actions are refused by kind.
A recipe with a step whose brewer produces commits must end with it, or it is refused with a line that names the fix: the cleanup of an ended batch deletes its attempt branches, so only a pull request keeps the commits.
The cleanup still keeps the branch of a task tree that no push recorded (a cancel, a skipped action), and says so ([ADR 0084](../../adr/0084-a-batch-s-commits-end-in-a-pull-request-or-on-a-kept-branch.md)); `foedrum status` lists it with the line that drops it ([ADR 0092](../../adr/0092-foedrum-status-lists-the-task-tree-branches-the-cleanup-keeps.md)).

A batch whose step left its recipe file goes Stuck on a divergence when that step's attempt ends, and a recipe done with no pull request puts its batch on tap without one ([ADR 0059](../../adr/0059-attempt-plans-from-the-brewer-of-the-step.md)).

**Step kinds:** `brewer` · `session` (an interactive step that runs in an engineer's Claude Code session: `refine`, `triage` or `review`; under the autonomous driver it waits visibly in the Stuck lane, with a reminder, a deadline and an optional automated fallback) · `check` (gravity reading: a named check, `build`, `typecheck`, `lint`, `format` or `test`, resolved through the repository's commands in `foedrum.jsonc` ([ADR 0023](../../adr/0023-language-independent-recipes.md)), or a list of them; in a Brewery's own recipe also a literal shell command, written as an object, `{ "run": "…", "windows": "…" }`, so a mistyped check name is an error, never a command) · `parallel` (a group of Tasters' lens steps run side by side; none of them writes the task tree, [tasting](tasting.md)) · `loop` · `gate: "human"` (approval with a required `deadline`) · `action` (`openPullRequest`, `comment`, `label`, `blend`) · `fanOut` (child orders per repository, scheduled as a dependency graph: `recipe` for every sub-order, otherwise the router picks; `approval`, default `true`; `bottling`: `perSubOrder` (default), `perRepo` or `manual`).

A step has exactly one of these kind fields.
A `session` step needs a `deadline` and may name a `fallback` brewer.

**Recipe fields:** `name`, `description`, `match` (`labels`), `steps`, and `testFirst` (default `true` for recipes that write code, decided when the recipe is loaded for a batch, since it depends on the brewers the recipe uses: unset, it is `true` when any brewer the recipe names produces `commits`, else `false` (`resolveRecipe`, [ADR 0028](../../adr/0028-brewer-runner-outcomes-environment-and-test-first.md)); the router may switch it off for documentation-only or pure refactoring orders and records why in the status comment).
A recipe has no time budget: the load refuses a `budget` field with a line that says it is gone, since each step's deadline, stall limit and attempts already bound a batch ([ADR 0194](../../adr/0194-a-recipe-has-no-time-budget.md)).

**Step fields**

| Field | Purpose |
|---|---|
| `id` | Unique step id within the recipe, nested loop and parallel steps included. Expressions (`tasting.verdict`), `goto`, `of` and `from: "step:<id>"` refer to it, and every reference must name a step. It is a file name on the state branch, so it follows `PathSafeId` (`src/schemas/ids.ts`): 1 to 64 lower-case letters, digits, `.`, `_` or `-`, a letter or digit at both ends, no Windows device name; `recipe` is reserved. Required, except on brewer steps (default: the brewer name) and actions (default: the action in kebab case, `open-pull-request`) |
| `when` | Run the step only when the expression is true; otherwise it is skipped and recorded as skipped. Expressions read step results by id (`tasting.verdict`, `mutants.survivors`) and the recipe's settings after routing (`recipe.testFirst`), optionally compared with a value in single quotes (`tasting.verdict != 'approve'`) |
| `lens` | Taster only (a brewer whose out doc schema is `tasting`), and required there: the lens that sets the review focus, given to the Taster as its input `lens`, `diff/<name>` or `plan/<name>` (`lenses/diff/<name>.md`, `lenses/plan/<name>.md`), of the folder of what the step reviews ([tasting](tasting.md), [ADR 0143](../../adr/0143-lenses-in-two-folders-diff-and-plan.md)) |
| `expect` | `check` only: `"pass"` (default) or `"fail"`. `"fail"` is a **red proof**, which runs `"check": "test"` only, because it reads the test report |
| `of` | Red proof only: an earlier step whose committed tests must fail because the behaviour is missing (a failed assertion or an error thrown by the code under test); load, compile, import or collection errors do not count |
| `blocking` | Taster: `true` makes a `changes` verdict block the step by findings, so its `onBlocked` route sends the batch back ([ADR 0161](../../adr/0161-lens-steps-run-a-taster-whose-findings-are-advisory-unless-the-step-blocks.md)). Brett: `true` makes confirmed surviving mutants block the tasting verdict, not followed yet. Default `false`, advisory |
| `onFail` | `check` only: `{ goto: <step id>, maxRounds }`. Like `onBlocked`, it goes back to an earlier step at the same level or in an enclosing loop, never forward or into another loop's steps |
| `onBlocked` | Brewer steps only: route a `findings` blocker outside a loop, e.g. `{ "findings": { "goto": "gauge", "maxRounds": 1 } }`; after `maxRounds` the batch becomes Stuck with the rounds it used and a recommendation to step back, and with a Taster's open findings when its step blocked ([tasting](tasting.md), [ADR 0192](../../adr/0192-a-findings-route-that-runs-out-of-rounds-goes-stuck-with-the-open-findings.md)). `environment` and `divergence` blockers are always Stuck ([the out doc contract](../recipes/out-doc.md)), so they take no route |
| `onPullRequestFail` | The `openPullRequest` action only: `{ goto: <step id>, maxRounds }`, a route like `onFail`. A check that fails on the open pull request's head sends the batch back to `goto`, and the fix is pushed to the same pull request; after `maxRounds` the batch becomes Stuck with the failed checks ([open pull requests](../intake/open-pull-requests.md), [ADR 0219](../../adr/0219-a-failing-check-on-an-open-pull-request-sends-its-batch-back-to-a-fix-step.md)) |
| `deadline` | Overrides the brewer's deadline for this step |

The red proof and `testsUnchanged`: [the red proof](../checks/red-proof.md).
Parallel groups and Brett: [tasting](tasting.md).

**Skipped steps.** An input from a skipped step is left out, and a `goto` or `onBlocked` route to a skipped step makes the batch Stuck (`divergence`) instead of jumping.
With `testFirst` off, Cellarman therefore gets no `tests` in-doc, and "this test is wrong" goes to a human.

**Test-first in bug-fix recipes.** The Microbiologist's reproducing test is the failing test: its step has `"id": "triage"`, the red proof uses `"of": "triage"`, and no Gauger step is needed.

**Escalation:** a brewer may set `"escalate": "<recipe>"` in its out doc; the batch re-routes (for example Half-pint → Growler).
