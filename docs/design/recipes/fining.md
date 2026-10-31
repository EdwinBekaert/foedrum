# Fining

**The Finer** simplifies a batch's change and commits it, before the checks and the reviews read it ([ADR 0166](../../adr/0166-the-finer-simplifies-a-batch-s-change-before-green.md)); in brewing, fining clears the haze before the beer is served.
The default one is `defaults/brewers/finer.md`, on the alias `builder`, a brewer that produces commits with `git.commit` and the guards `requiresOutDoc`, `requiresCommits` and `testsUnchanged`.
Its `## What to look for` lists duplication (in the change, and against code the repository already has), dead code, needless indirection and over-general code; it applies the smaller form that does exactly what the code does now.
Its `## What you may change` keeps it to files the change already touches, away from the lines the red step added to test files (the `testsUnchanged` guard holds the red proof's tests), from `package.json`, the lockfile, `.npmrc`, CI, hooks and settings, and from error messages, output formats and public interfaces.
It runs the repository's format, lint, typecheck and the tests that cover what it changed before it commits.
A brewer whose out doc schema is `fining` gets the input `change`, as a Taster that reviews a diff does ([tasting](tasting.md)).
Its out doc adds `changes`, at most 50 of `{ file, line, why }` with `line` optional, or `unchanged`, one line of why there was nothing to simplify: a `done` has exactly one of them.
A `done` with `unchanged` and no commit succeeds; with `unchanged` and commits it fails and is tried again; with `changes` and no commit it is the divergence every brewer that produces commits gets ([how a brewer runs](how-a-brewer-runs.md)).
The status comment lists the changes of each `fining` step whose latest attempt succeeded in a **Simplifications** section, ten per step and a count of the rest, or `nothing to simplify: <why>` ([GitHub](../humans/github.md)), and the pull request's step reports list them under the step ([openPullRequest](open-pull-request.md)).
Nip runs it as `fine`, between `implement` and `green`; a failing green still goes back to `implement`, and the Finer then runs again on the fixed change.
`/brew-review` stage 2 reads the same two sections and proposes patches instead of committing.
