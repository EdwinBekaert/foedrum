# Seeded plan for the tasting comparison

An order and a plan made for it, with one planted mistake per default plan lens, which `node scripts/tasting-compare.ts --plan` tastes apart and together ([ADR 0323](../../../../docs/adr/0323-a-seeded-plan-measures-the-plan-lenses-apart-and-together-after-the-merge.md), #804).
Each mistake is its lens's, on sub-orders of its own, and every other field of those sub-orders is meant to be right.
The files are data: `test/unit/tasting-compare-plan.test.ts` reads them against the base, and the plan step is scripted, so no model writes the plan.

- The base is the diff mode's `../0001-Start-pantry.patch`, unchanged: the repository `pantry`.
- `order.md`: the order's issue text, its title on the first line, with a "What to build" checklist and a "Later" section that is not part of it.
- `plan.json`: the plan's out doc fields, ten sub-orders, every one in `demo/web`.
- `key.json`: each planted mistake's lens, its sub-orders, the field it is in, and what it is.
- `prose.jsonc`: a second recipe that builds. Recipe fit has nothing to judge while a Brewery has one recipe that builds, so the plan's `rename` names this one, and its `readme` fits it.

## Expected findings

| Lens | Sub-order | Field | The planted mistake |
|---|---|---|---|
| coverage | `validate` | `title` | it builds what `load` in `src/store.mjs` already does |
| naive reader | `past-date` | `size.mechanism` | "the grace rule" is explained by neither the entry nor the order |
| order and overlap | `keep-backup`, `atomic-save` | `dependencies` | both change `src/store.mjs` and `test/store.test.mjs`, and no dependency puts them in order |
| recipe fit | `rename` | `recipe` | code with a test, on the recipe for a page of prose |
| security | `notify` | `size.mechanism` | an item's name, from a file in a shared folder, reaches a shell command line, and nothing says how that is held |
| sizing | `stats` | `size.lines` | 3,000 lines is more than a person can review as one change |
| testability | `remove` | `doneWhen` | "it works" is a wish that no test or run can decide |

`remind` and `readme` are clean, as controls.
Every other pair that shares a file is in order by a dependency, and a test checks that only the planted pair stands side by side.

A finding counts for a mistake when its `why` starts with one of the mistake's sub-orders, with or without backticks around the id, whatever lens it names.
A finding on either sub-order of the pair counts for that mistake.
A finding on a clean sub-order, on an id that is no sub-order's, or on none is listed by the script as another finding, for a person to judge.

Findings that may appear and are not wrong:
- "it works" read by naive reader, whose file also names it as a `doneWhen` it cannot check: it counts for the testability mistake, and the own-lens column shows whose finding it was;
- the dependencies that put the commands in a line read as not needed: order and overlap's file says that entries in order on one file are no finding, so one that appears is that lens's other finding on a planted sub-order, and counts by its place;
- tests of `load` and `save` that need a file, against the base's CLAUDE.md rule of plain data in tests;
- `notify`'s `<command>` itself, which the person running it writes, is not the planted input: the item's name is.

A lens that misses its own mistake apart, in most runs, is a finding about that lens for an issue of its own.
