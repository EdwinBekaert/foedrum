# 0143. Lenses in two folders: lenses/diff/ for a diff, lenses/plan/ for a plan

Date: 2026-10-23 · Status: Accepted · Amends [0098](0098-foedrum-s-defaults-load-under-the-brewery-s-files-and-a-brewer-input-can-name-a-lens.md) (where lenses are, how a lens is named, and what replaces a default lens), [0022](0022-five-default-lenses.md) and [0017](0017-test-first-recipes-and-tasting-lenses.md) (where the five default lenses are), and [0100](0100-nip-ships-with-a-default-cellarman-and-the-default-brewers-name-the-builder-alias.md) (the Gauger's lens input)

## Context
Every lens so far reviews a diff: the five default lenses ([ADR 0022](0022-five-default-lenses.md)) read code and its tests.
The analyse recipe (#373) adds a second kind of review: a plan, analyze's breakdown of an order, reviewed before the engineer sees it by plan lenses of their own (#391).
A plan is mostly prose, and it is reviewed with other questions than code: is it the right work, cut the right way.
Both kinds need a security lens, so the two cannot share one folder of names.
A plan lens on a diff, or a diff lens on a plan, reviews the wrong thing and says so nowhere.
Today `defaults/lenses/*.md` and a Brewery's `lenses/*.md` hold one flat list, and a lens is named by its file name alone (ADR 0098).

## Decision
- **Two folders.** A lens is in `lenses/diff/` when it reviews a diff and in `lenses/plan/` when it reviews a plan, in the Brewery and in Foedrum's `defaults/lenses/`. The five default lenses move to `defaults/lenses/diff/`; `defaults/lenses/plan/` stays empty until #391.
- **A lens is named by its folder and file name.** `diff/security`, `plan/coverage` (`LensName` in `src/schemas/ids.ts`): a brewer input reads `"from": "lens:diff/test-design"`, and a step's `lens` is `"diff/security"`. A name without one of the two folders fails the schema. The Gauger's input becomes `lens:diff/test-design`.
- **A Brewery file replaces the default of the same folder and name.** `lenses/plan/security.md` replaces `defaults/lenses/plan/security.md` and leaves `defaults/lenses/diff/security.md` in use. Everything else in ADR 0098 stands.
- **A lens file directly in `lenses/` fails the load.** Its line says where it belongs: `lenses/security.md: a lens belongs in lenses/diff/, to review a diff, or lenses/plan/, to review a plan (ADR 0143)`. The same holds for a file directly in `defaults/lenses/`. Files in another folder under `lenses/`, or further down, are not read, as with recipes and brewers.
- **What a step reviews follows from the recipe.** A step with a `lens` reviews a diff once a step before it, in the order `walk` lists a recipe's steps (nested loop and parallel steps included), has a brewer that produces commits; otherwise there is no diff yet, and it reviews a plan. A step whose lens is of the other folder fails the load with one line that names the step and the lens: `recipes/<name>.jsonc: step "taste" reviews a plan, since no step before it commits, and names the lens "diff/security", which reviews a diff: name a lens of lenses/plan/ (ADR 0143)`, and the same for the reverse, naming the step that commits. `foedrum doctor` gives these lines like every load line. This is validation where the recipe enters, not a new safeguard: it reads a field the recipe already has against the recipe's own steps.
- A step's `lens` still fails the load as a field the engine does not follow yet (ADR 0053) until #26; the folder line comes with it, so a recipe written today already has the lens it will need.

## Consequences
- A Brewery with a lens directly in `lenses/` stops loading until it moves the file to `lenses/diff/` (or `lenses/plan/`) and renames its inputs to `lens:diff/<name>`. The line names the file and both folders.
- The lens of a prompt's input is tagged with its folder and file: `lens diff/test-design, file defaults/lenses/diff/test-design.md`.
- The review skill (`/brew-review`) reads its lenses from `defaults/lenses/diff/`, and from `defaults/lenses/` when the base is older than this record, so a pull request is still reviewed by its base's lenses. The plan lenses are not pull request lenses.
- #391 adds the six plan lenses as files of `defaults/lenses/plan/`, with no change to the load.
- A house-yeast rule's lens scope stays a bare lens name (`security`), as the review skill names its lenses: no rule is scoped to a plan lens yet, and how one names it is #391's to settle.

## Alternatives considered
- **A `reviews: "diff" | "plan"` field on the step, or on the lens file.** One more field to keep in step with the folder, and a lens has no frontmatter (ADR 0098). The recipe already tells: there is no diff before a step commits.
- **Unique lens names across one folder** (`plan-security`). Simpler to load, but nothing would stop a plan step naming `security`, and the kind would live only in a naming habit.
- **Read the kind from the brewer** (a Taster reviews a diff). The same Taster reviews both kinds; only the lens and the place in the recipe differ.
- **Keep loading a lens directly in `lenses/` as a diff lens.** It would load quietly as a kind it may not be, which is the mistake the folders are there to name.
