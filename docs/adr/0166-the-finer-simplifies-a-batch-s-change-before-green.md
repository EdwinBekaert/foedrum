# 0166. The Finer simplifies a batch's change before green, and may end done without a commit

Date: 2026-10-24 · Status: Accepted · Amends [0017](0017-test-first-recipes-and-tasting-lenses.md) (one more default brewer, and the review skill's simplify stage reads the Finer's instructions), [0074](0074-git-commit-grants-fixed-git-rules-and-done-needs-a-commit.md) (a `fining` out doc's `done` with nothing to simplify needs no commit), [0161](0161-lens-steps-run-a-taster-whose-findings-are-advisory-unless-the-step-blocks.md) (a `fining` brewer gets the `change` input too), [0100](0100-nip-ships-with-a-default-cellarman-and-the-default-brewers-name-the-builder-alias.md) (Nip gains its Finer step), [0059](0059-attempt-plans-from-the-brewer-of-the-step.md) (a `fining` out doc is read against its own schema), [0071](0071-the-openpullrequest-action-two-effects-of-the-batch.md) and [0167](0167-a-brewed-pull-request-follows-one-layout-and-opens-as-a-draft-unless-every-taster-approves.md) (the step reports list a Finer's changes), [0072](0072-the-status-comment-edits-as-revisions-in-the-ledger.md) (the status comment's Simplifications section) and [0088](0088-out-doc-text-that-looks-like-a-secret-is-left-out-of-the-pull-request-and-the-status-comment.md) (a Finer's changes and reason are read for secrets in both)

## Context
Simplifying changes the code, so it comes before the review that judges the final code.
The review skill for Foedrum's own pull requests already works that way: its stage 2 simplifies, its stage 3 reviews the simplified code ([ADR 0017](0017-test-first-recipes-and-tasting-lenses.md)).
A recipe does not: Nip goes implement → green → taste, and nothing makes a batch's change smaller before the Taster reads it.
#429 and #446 proposed a shipped `diff/simplify` lens, but a Taster only reports: its findings would sit in the pull request for a person to apply, and a Taster that reported simplifications after another step had made them would review that step's work.
Two lists of what to simplify, the skill's `lenses/simplify.md` and a shipped lens, would drift apart.

The maintainer decided the shape in #455 on 2026-10-24.

## Decision

### The Finer
- **A new default brewer, the Finer** (`defaults/brewers/finer.md`; in brewing, fining clears the haze before the beer is served), simplifies the batch's change and commits it, in one run.
  It is a brewer that produces commits, on the alias `builder` ([ADR 0153](0153-foedrum-s-defaults-map-their-own-model-aliases.md)), with `Read`, `Edit`, `Write`, `Grep`, `Glob` and `git.commit` ([ADR 0074](0074-git-commit-grants-fixed-git-rules-and-done-needs-a-commit.md)), and the guards `requiresOutDoc`, `requiresCommits` and `testsUnchanged`.
- **What it looks for** is one list, under `## What to look for` in its file: duplication in the change and against code the repository already has, dead code, needless indirection and over-general code; it applies the smaller form that does exactly what the code does now.
  The list starts from #446's `defaults/lenses/diff/simplify.md`.
- **What it may change** is the next section, `## What you may change`: only files the change already touches; never a test declaration or assertion, which the `testsUnchanged` guard holds against the red proof's tests ([ADR 0017](0017-test-first-recipes-and-tasting-lenses.md)); never `package.json`, the lockfile, `.npmrc`, CI, hooks or settings; and no change to an error message, an output format or a public interface.
  Only the test rule is a guard; the rest is the prompt's, and green and the Taster read what it did.
- **It runs the repository's format, lint, typecheck and the tests that cover what it changed** before it commits, as the Cellarman does (#432), so a simplification that breaks something is undone in its own run, not found by green.
- **It reads the change from the engine**: a brewer whose out doc schema is `fining` gets the `change` input, the commits and diff from the commit its batch started at to HEAD, as a Taster that reviews a diff does ([ADR 0161](0161-lens-steps-run-a-taster-whose-findings-are-advisory-unless-the-step-blocks.md)), since `git.commit` gives it no `git diff`.

### The `fining` out doc
- **A brewer whose out doc schema is `fining`** (`FiningOutDoc`, `src/schemas/out-doc.ts`) adds two fields to the contract:
  - `changes`: at most 50 of `{ "file", "line", "why" }`, each change it made, `line` optional;
  - `unchanged`: one line of at most 1,000 characters, why there was nothing to simplify.
  A `done` has exactly one of them: a non-empty `changes`, or `unchanged`. An out doc with both, or neither, is invalid, and its attempt is tried again.
- **Nothing to simplify is a valid end** (amends ADR 0074): `settleAttempt` settles a `done` with `unchanged` and no commit since the start as a success, the last rule before ADR 0074's divergence.
  A `done` with `unchanged` and commits contradicts itself, so its attempt fails and is tried again (`the out doc says nothing was simplified, but the brewer made <n> commits since <sha>`); a retry starts from the task tree, so the commits do not carry over.
  A `done` with `changes` and no commit is ADR 0074's divergence, as for any brewer that produces commits.
  So the schema, not the brewer's name, is what the engine reads, and a Brewery can write a Finer of its own.
- **The status comment shows the changes** in a **Simplifications** section, the latest succeeded attempt of each `fining` step, ten per step and a count of the rest, as `<file>:<line>: <why>`, or `nothing to simplify: <unchanged>`; through the same filters as the findings (one escaped line, secrets left out, [ADR 0088](0088-out-doc-text-that-looks-like-a-secret-is-left-out-of-the-pull-request-and-the-status-comment.md)).
- **The pull request's step reports list them** under the step, in the fenced block ([ADR 0167](0167-a-brewed-pull-request-follows-one-layout-and-opens-as-a-draft-unless-every-taster-approves.md)): `  simplified: <file>:<line>: <why>` per change, or `  unchanged: <unchanged>`.
  A `fining` step does not change whether the pull request opens as a draft.

### In the recipes
- **Every default recipe has the step**: Nip gets `{ "id": "fine", "brewer": "finer" }` between `implement` and `green`, and each default recipe still to come includes it after its last writing step and before its checks.
- **Green's `onFail` route still goes back to `implement`.** A failing green after the Finer sends the Cellarman the failed reading as its route input ([ADR 0128](0128-an-attempt-a-route-schedules-gets-what-sent-it-back.md)), whichever step broke the code, and the Finer then runs again on the fixed change, since `fine` follows `implement`.
  A route back to `fine` would hand the Finer a failure it may not have caused, with no right to fix code beyond simplifying it.
- **No shipped `diff/simplify` lens.** A Taster that reported simplifications after the Finer would review what the Finer did.

### In the review skill
- **`/brew-review` stage 2 runs the Finer's instructions**: its `taster` reads the two sections of `defaults/brewers/finer.md` from the review's criteria and answers with proposed patches, which the skill sorts, applies and tests in its scratch tree as before.
  `.claude/skills/brew-review/lenses/simplify.md` goes: one list of what to look for, used by the recipes and by the skill.

## Consequences
- A Nip batch's change is simplified before green checks it and before the Taster reads it, and the pull request says what the Finer changed and why.
- Every Nip batch runs one more brewer: the Finer's time (its deadline is 20 minutes) and its tokens, a prompt of about 700 words, the order, the change (up to 256 KiB) and the files it reads around it. A Brewery that does not want it replaces `nip.jsonc` (ADR 0098).
- A batch whose change needs no simplifying pays that run too, and its status comment says why there was nothing to do.
- The Finer can make a change worse in ways no test sees (a rename that reads worse, a merge of two functions that should stay apart); green and the Taster read the result, and its out doc names each change for the person who reviews the pull request.
- The review skill's simplify stage and the recipes now share their list: a change to `## What to look for` changes both, and is exercised by a planted-defect run as any prompt change is.

## Alternatives considered
- **A shipped `diff/simplify` lens** (#446): findings a person applies by hand, and a Taster that reviews another step's work when one simplifies before it.
- **The Finer after green, with its own green after it**: one more check run per batch for the same result as running the checks in the Finer's own attempt.
- **Nothing to simplify as a `blocked` out doc**: the batch would go Stuck for a human on a change that needed nothing.
- **A brewer-file flag that lets any brewer end done without a commit**: wider than this brewer needs, and a Cellarman with it set would lose its work without a word again ([ADR 0074](0074-git-commit-grants-fixed-git-rules-and-done-needs-a-commit.md)).
- **Green's route back to `fine`**: the Finer would get a failure it may not have caused.
- **Keep the skill's own simplify lens**: two lists that drift apart.
