# 0403. A skill tastes the settings a person names, and a script unblinds a blind scorer's marks

Date: 2026-11-16 · Status: Accepted · Amends [0332](0332-tasting-compare-real-re-tastes-brewed-heads-and-writes-blinded-lists.md) (the lists are scored by a model the skill starts, and a script counts its marks)

## Context
`tasting-compare --real --brewer taster` tastes the brewed heads with a setup built from four settings ([ADR 0402](0402-tasting-compare-real-tastes-with-a-taster-setup-built-from-settings.md)).
What came after it was done by hand twice in #879: a scorer who had not seen the setups marked the lists against the key, a person unblinded the marks through `codes.md` and wrote the table.
#1081 asks for that handwork in a skill.

## Decision
- **`/brew-tasting`** (`.claude/skills/brew-tasting/`) takes #937's four settings, with `--comparison`, `--runs`, `--key` and `--dry-run`, and runs `tasting-compare --real --brewer taster` with them. Only a person starts it: it spends tokens.
- **Without `--comparison`, the comparison is named `t-` and 8 hex digits of a sha256 of the four settings**, so the same settings go on in the same folder. A name that spells the settings fails on Windows: each run's scratch path already holds the setup's name, and the two passed the path limit in a dry run. The skill prints the name, its folder and the settings when it starts.
- **Another tool is refused**, such as Codex, naming #839, until a second runner exists.
- **The key is read at run time**: the section "The key and the bar, fixed before any run" of #879 and of each issue `--key` names, into the comparison's scratch folder. It is never committed, since a Taster reads the repository. Its table's Id and Order columns give the key items and their orders, so a fourth order, such as #915's, needs only its issue.
- **A fresh `taster` agent scores blind.** Its prompt holds the key and the lists of the key's orders, and no path; it is told to open no file and answers with its marks only. It is never given `codes.md` or `bodies/`. Its tools are Read, Grep and Glob behind the read guard ([ADR 0049](0049-reviewers-read-only-inside-the-checkout.md)): the lists and the key are untrusted text, and this tool limit, not the prompt, is what keeps injected text from running a command, writing or reaching the network. The skill writes its answer to `marks.json`: per run code, the key items caught and each finding outside the key with a verdict, `true` or `false`.
- **`scripts/tasting-score.ts` unblinds the marks** through `codes.md` into `scored.md`, as #879's comments show the table: per setup, `n/m` per key item, the findings outside the key as true and false, tokens per batch as a mean and a range, and the models its Tasters ran on, with how many. A model a settings setup did not ask for is marked `not asked` (ADR 0402's `isAsked`), so an alias that moved shows. Marks that do not fit are refused, every problem at once: an order not in the key, a code `codes.md` does not hold for that order, a caught item not of its order, a run of a key order with no mark, and a code marked twice. A marks file with a BOM reads as without one, and a value the scorer wrote goes on its refusal line with its line breaks escaped.
- **The script judges nothing.** Whether a finding names a key item is the scorer's; ADR 0332's "the program scores nothing" holds for the comparison, and the script only counts.
- **`--dry-run`** runs the comparison scripted and stops before the scorer, saying where the lists and `codes.md` are.

### A Brewery's files
None: this is a skill and a script of Foedrum's own repository, and no Brewery file changes, so no Brewery needs a migration.

## Consequences
- A comparison of new settings is one command and one scorer's session, and the table comes out the same each time.
- Blindness against `codes.md` is still a prompt rule: the scorer can Read inside the checkout, where `codes.md` is. It rests on the prompt holding no path and the lists naming no setting.
- Scoring by program and a key in the repository stay out (#1081).
