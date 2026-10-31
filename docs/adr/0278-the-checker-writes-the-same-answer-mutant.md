# 0278. The checker writes the same-answer mutant beside Brett's

Date: 2026-10-31 · Status: Accepted · Amends [0034](0034-brett-mutants-as-structured-line-edits.md) (a mutant may come from the checker, not only from Brett)

## Context
`/brew-review`'s reviewer prompt asked Brett for one mutant per changed boolean function whose assertions all expect the same value: the function returns that value for every input. Such a mutant survives exactly when the tests cannot tell the function from a stub that always gives that answer. On the planted-defect sample, `isBreweryName` (patches `0007` and `0008`) is that case, and the sample's README expects the mutant to survive. In the planted run of 2026-10-18 (#213, #216), Brett proposed three to five other mutants and not this one (#223). An instruction to a model gives what it asks for usually, not always, and this case needs no judgement: the function, its assertions and the one-line edit can all be read from the files.

ADR 0034 says Brett gives each mutant as a one-line structured edit, which the checker checks and applies.

## Decision
- **`scripts/mutants.ts --same-answer` writes this mutant itself.** From the files the change touches (`files.txt`) at `<head>`, it takes each function of a file under `src/` or `scripts/` declared to return `boolean`, with a name no other such function of the change has, whose result is one expression on one line: an arrow's expression body, or a block's only `return <expression>;`. In the touched test files, which must each import the function from that file when they use its name, it reads the assertions on it: `assert(…)`, `assert.ok(…)`, and `assert.equal`, `strictEqual`, `deepEqual` and `deepStrictEqual` against `true` or `false`, each also with `!` before the call. When every mention of the function outside imports, strings and comments is such an assertion and all expect one value, the mutant writes the result as `false && (<expression>)` or `true || (<expression>)` on that line.
- **The mutant is appended to Brett's answer**, marked `"source": "script"`, after Brett's answer is saved; a second run adds no mutant the answer already holds, and no run removes one of Brett's. It is then checked, applied and judged like Brett's: one existing line of a touched file, only a boolean literal and brackets added, killed only by a test it makes fail (ADR 0040).
- **Brett's prompt keeps the request as the fallback** for a boolean function the script cannot read (another assertion form, a table of cases, a result over several lines).

## Consequences
- The planted sample's always-false mutant of `isBreweryName` is in every run, and Brett's three to five mutants go to other bugs.
- A function the script cannot read still depends on Brett, as before. A test file that mentions the function in any other way gives no scripted mutant, so the script never claims a gap it cannot see.
- When Brett also proposes the same mutant, it runs twice with the same verdict; that costs one test run.
- A review whose criteria predate `--same-answer` (the base of the pull request that adds it) skips the step.

## Alternatives considered
- **Run the script before Brett and tell Brett which functions it covered.** It needs a second answer file and a merge before the mutants are numbered; the prompt naming the forms the script reads does the same with one file.
- **Only the functions whose lines the diff changes.** It needs the diff's hunks; a touched file is the scope ADR 0054 already gives every mutant, and an unchanged function's tests in a touched test file are still the change's tests.
- **Drop the request from Brett's prompt.** A boolean function tested through a table of cases would then get no such mutant at all.
