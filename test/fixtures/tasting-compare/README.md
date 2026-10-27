# Seeded change for the tasting comparison

An order and a change made for it, with one planted defect per default diff lens, which `node scripts/tasting-compare.ts` tastes apart and together ([ADR 0224](../../../docs/adr/0224-the-default-recipes-taste-apart-or-together-as-a-seeded-comparison-measured.md), #567). Each defect is its lens's and not another's, on lines of its own. The files are data: no test applies them; `test/unit/tasting-compare-core.test.ts` reads `key.json` against the lines the change adds.

- `order.md`: the order's issue text, its title on the first line, with a "What to build" checklist of five items and a "Later" section that is not part of it.
- `0001`: the base, a tiny repository `pantry`: a CLAUDE.md with the rule that only `src/store.mjs` touches the file system, a README that says a pantry file can sit in a folder a household shares, `src/store.mjs` (whose `load` validates every item), `src/pantry.mjs`, `src/cli.mjs` and one test.
- `0002`: the change, as a brewer could have made it for the order. Every item of the checklist is built.
- `key.json`: each planted defect's lens, file, line ranges in the file after `0002`, and what it is.

## Expected findings

| Lens | Where, after `0002` | The planted defect |
|---|---|---|
| acceptance | `src/cli.mjs:43` to `46` | an `export` command no item asks for |
| correctness | `src/pantry.mjs:8` to `9`, `17` | `DAY_MS` is an hour's milliseconds, so `daysLeft` counts hours and items a few days ahead are missed |
| cross-platform | `src/cli.mjs:12` to `13` | `process.env.HOME` is unset on Windows, where `join` then throws |
| design-conformance | `src/cli.mjs:3`, `14` to `15` | `cli.mjs` imports `node:fs` and reads `.pantryrc` itself, against CLAUDE.md's rule |
| necessity | `src/cli.mjs:32` to `37` | a guard that checks every best-before date again, which `load` already validates where the file enters |
| security | `src/cli.mjs:16` | `.pantryrc`, which can sit in a shared folder, is run as code through `Function` |
| test-design | `test/pantry.test.mjs:22` to `25` | the `expiringSoon` test asserts only that each item listed is an item: it passes on an empty list and in any order, so it misses the hours-for-days defect |

A finding counts for a defect when its file is the defect's and its line is in one of the ranges, whatever lens it names.

Findings that may appear and are not wrong, listed by the script as other findings for a person to judge:
- `remind --days` with no number after it gives `NaN`, and nothing is listed (correctness);
- `remind` reads `new Date()` itself instead of being given the day (correctness, determinism);
- `export` has no test (test-design), and its CSV does not quote a name with a comma (correctness): both on the acceptance defect's lines, so they count for it;
- the `HOME` line read as an unhandled `undefined` (correctness) counts for the cross-platform defect, and `Function` read as unvalidated input (correctness) for the security one, by their lines;
- the "a test pins down `expiringSoon`" item read as built in part (acceptance), at the test's lines, counts for the test-design defect.

A lens that misses its own defect apart, in most runs, is a finding about that lens for an issue of its own; ADR 0224 changes no lens file.
