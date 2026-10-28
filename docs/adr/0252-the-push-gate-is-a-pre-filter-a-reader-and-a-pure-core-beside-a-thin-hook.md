# 0252. The push gate is a pre-filter, a reader and a pure core beside a thin hook

Date: 2026-10-28 · Status: Accepted · Amends [0045](0045-the-local-gate-reads-commands-as-the-shells-would.md) (where the gate's code lives), [0132](0132-the-gate-reads-what-gh-posts-against-the-personal-denylist.md) (where the gh texts are read and `forbiddenReason` lives) and [0056](0056-the-gate-pre-filter-reads-the-command.md) (what loads before the pre-filter lets a command go)

## Context
The local gate (`scripts/precheck.ts`, [ADR 0045](0045-the-local-gate-reads-commands-as-the-shells-would.md)) was one file of 2,049 lines: the pre-filter, the shell-word lexer, the reader that finds each `git push`, `gh` and `npx` call and where it runs, every policy on what the reader found (the tree a push comes from, git's push configuration, the denylist hand-off, `npx`, `gh pr ready`'s review summary) and the hook's shell, which starts git, gh and npm.
It changed in more commits in October 2026 than any other file, and judging one rule meant holding the lexer, the reader and the policies in mind together; two sessions that each add a rule conflict in it (#617).
The other decision scripts keep a pure part apart from a thin shell: `scripts/denylist/core.ts` beside `scripts/denylist.ts`, `scripts/mutants/`, `scripts/affected-tests/core.ts` beside `scripts/affected-tests.ts`.
The gate stayed whole for its start: it runs before every Bash and PowerShell call, so a command the pre-filter lets go ([ADR 0056](0056-the-gate-pre-filter-reads-the-command.md)) must load nothing more, and the module had no static imports.
A split does not need one file for that: precheck already loads its other modules with a dynamic import after the pre-filter.

## Decision
- **Four files, by what each part does.**
  - `scripts/precheck/prefilter.ts`: the pre-filter (`mayNeedTheGate`) and the quote folding it shares with the lexer (`foldQuotes`, `normalised`, `jsonLineBreaks`). It imports nothing.
  - `scripts/precheck/read.ts`: the lexer (`lex`) and the reader (`findings`, from wrapper words, package runners and changes of directory to the git, gh, recursive-delete and nested-shell readers), with the refusal lines of the rules it applies as it reads (force, delete, configured push, `gh pr merge`, a computed `gh pr` action or `gh pr ready` argument, too deep, a recursive delete of a computed path).
  - `scripts/precheck/core.ts`: the pure policies on what the reader found, with their refusal lines: `resolvePlace`, `projectHolds`, `configuredDelete`, `forbiddenReason`, `readyRefusal` and `gate`, the part of the hook after the pre-filter, with the injected functions' types.
  - `scripts/precheck.ts`: the hook. `precheck` runs the pre-filter on the raw input, parses the JSON and runs the pre-filter on the command, as before, and only then loads `core.ts` (which loads `read.ts`) with a dynamic import and hands it the command; the shell functions that start git, gh and npm, and the `import.meta.main` block, stay in it.
- **One static import.** `scripts/precheck.ts` imports `prefilter.ts` statically, a file with no imports of its own, so a command the pre-filter lets go loads those two files and nothing else.
  The pre-filter has to be a superset of the lexer's reading, so the two share one copy of the quote folding rather than two that could drift.
  `read.ts` cannot import it from `precheck.ts`: the hook's main block awaits at the top level, and a module loaded by its dynamic import that imports the entry module back would wait for it forever.
- **A pure move.** No rule, message or order of checks changes; the gate's tests change only their imports, except the integration test of what a call the pre-filter lets go loads, which now expects the pre-filter too.
- **Tests import a name from the module that holds it.** `scripts/precheck.ts` re-exports nothing from `read.ts` or `core.ts`, which would need a static import of them.

## Consequences
- A rule is judged in the file that holds it: a reading rule in `read.ts`, a policy in `core.ts`, a process in `precheck.ts`.
- A command the pre-filter lets go loads one more small file than before; the pull request measures the hook's time for `ls` and for a command it reads, before and after.
- CLAUDE.md's gate lines follow in a docs pull request after this one: "The logic lives in `scripts/precheck.ts`" (Local gate), which now has its parts in `scripts/precheck/`.

## Alternatives considered
- **The pre-filter's helpers copied into `read.ts`:** no static import, but a pre-filter that must stay a superset of the lexer's quote reading could drift from it.
- **`precheck` whole in `core.ts`:** the pre-filter would then run only after the import it exists to avoid.
- **The refusal lines all in `core.ts`:** the reader pushes its own, so `read.ts` and `core.ts` would import each other.
