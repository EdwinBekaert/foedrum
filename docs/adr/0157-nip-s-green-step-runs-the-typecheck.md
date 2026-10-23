# 0157. Nip's green step runs the typecheck

Date: 2026-10-23 · Status: Accepted · Amends [0100](0100-nip-ships-with-a-default-cellarman-and-the-default-brewers-name-the-builder-alias.md) (Nip's green checks)

## Context
ADR 0100 gave Nip's `green` step four checks, `build`, `lint`, `format` and `test`, and no reason for leaving out `typecheck`, the fifth check name a repository can set in `foedrum.jsonc` (ADR 0023).
In the first order Foedrum brewed on itself (#374, pull request #410), the Brewery set `"typecheck": "npm run typecheck"`, and the green step's readings held no typecheck reading.
Foedrum's tests run as type-stripped TypeScript, so a type error in Cellarman's change passes every green check and reaches the pull request, where only CI catches it (#411).

## Decision
- **Nip's `green` step runs `["build", "typecheck", "lint", "format", "test"]`**, in `defaults/recipes/nip.jsonc` and in the test fixture `test/fixtures/recipes/nip.jsonc`.
- The typecheck goes after the build, which may produce what it reads, and before lint, format and test, the order of a repository's own check.
- A repository without a typecheck keeps it `null` in `foedrum.jsonc`: the step skips it and records the skip, as it does for every other check set to `null`.

## Consequences
- A type error in Cellarman's change fails green and goes back to Cellarman once (`onFail`), before the pull request opens.
- A Brewery that sets `typecheck` gets one more reading per green attempt, and its time; one that does not sees one more skipped reading.
- A Brewery with its own `nip.jsonc` keeps its own list; the change reaches only Breweries that use the default.

## Alternatives considered
- **Leave it to the repository's `test` command.** Some repositories run the typecheck inside `test`, but Foedrum's does not, and a check of its own reads as its own line in the status comment.
- **Rely on CI.** CI catches the error only after the pull request opens, and the fix then needs another order or a person, where green would have sent it back to Cellarman.
