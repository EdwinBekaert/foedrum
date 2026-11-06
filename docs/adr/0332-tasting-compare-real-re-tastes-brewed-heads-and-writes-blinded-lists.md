# 0332. tasting-compare --real re-tastes brewed heads and writes blinded lists

Date: 2026-11-06 · Status: Accepted · Amends [0224](0224-the-default-recipes-taste-apart-or-together-as-a-seeded-comparison-measured.md) (the comparison has a mode on real changes, scored by a person) and [0323](0323-a-seeded-plan-measures-the-plan-lenses-apart-and-together-after-the-merge.md) (the mode's seams, which now say how a run builds its target and which recipe it brews)

## Context
Nothing can say whether a change to the Tasters makes them better, and #876, #877 and #878 all aim to.
#374's three self-brew orders showed why it matters: `nip`'s Tasters approved heads where `/brew-review` then found majors and a stale design page.
The seeded modes cannot answer it.
Their tiny repository has none of the rules, decision records and design pages a Taster would read, and they score by line, while a stale page is a file the change did not touch.

## Decision
- **The heads as brewed, not as merged:** #855 at `62d71154`, #864 at `5590e9c5` and #867 at `f4fb4585`, each on its order's base. The merged heads already hold the review's fixes.
- **The target** is this repository at the base, fetched at depth 1 with no tags into a scratch remote, so the remote holds no later history. A Taster has no git today, and this does not rest on that.
- **A scripted Cellarman** commits the head's changed files, read from the checkout the script runs in; a commit that is not there stops the run and says so. A brewed head has two commits, tests and change, and a Taster sees them as one, with the head's subject. It is the same diff, and no lens in `nip` reads commit shape. The six pushed trees were compared with the heads by hand in the dry run, and each is the same.
- **A head it could not commit as it is refuses to run**, rather than tasting something else: one that deletes a file, one that renames one, which reads as a delete since git is asked for no renames, or one that changes a file's kind. None of the three does.
- **The order text** is `test/fixtures/tasting-compare/real/<order>.md`, the issue's title and body and nothing else. Each body's last edit is older than its brewed head. A comment on an order is not part of it: #877 adds a setup with #867's.
- **The recipe** is one, `real-nip`, with `nip`'s three lenses side by side and nothing blocking, so every run ends. A test holds its lens list to `defaults/recipes/nip.jsonc`.
- **The setups** are `today`, with the scratch Brewery's `brewers/taster.md` replaced by the text at `765cc856`, and `reads`, with the default Taster, which #876 changed. The script refuses to run when the two texts are the same, since the comparison would then be of nothing. A setup's name holds its order, such as `855-today`, so a run is its order, setup and run in a record that reads on its own. The run order is order by order, setup by setup. #877 is to add a third setup on #867 only.
- **Models:** no `models.jsonc`, as in the other modes, so the Tasters run on the default `builder`, `sonnet`. The maintainer's Brewery pinned `builder` to `claude-sonnet-5-5` then. Each attempt's record keeps the model claude's receipt names, so a later setup on another model compares fairly.
- **What a record keeps:** ADR 0224's fields, and each Taster's `riskLeft`, its models, the files it opened by path, what it reached outside its worktree and what it asked for outside and got an error for.
- **A Taster that read outside its worktree fails its run.** The checkout around the scratch folder holds later decision records, so that run is no measurement. It is read from the attempt's transcript, found by its session id under `projects/` in Claude Code's config directory ([ADR 0116](0116-the-driver-records-each-attempt-s-session-and-claude-s-report-goes-on-step-finished.md)). Only `Read`, `Edit`, `Write`, `Grep` and `Glob` calls that came back without an error count. A `Glob` whose pattern holds `..` past a wildcard counts as outside, wherever it lands.
- **A refused call read nothing.** It is listed and fails no run.
- **A transcript that cannot say fails its run too:** one that is not found, one with a line that cannot be read, one that shows a tool whose reads cannot be told, or one with no tool call at all. The last keeps a new transcript format from reading as "stayed inside". A Taster's out doc is written with a tool, so its `Edit` is that call: a Taster that opened no file and judged from its prompt passes. On the trial orders most did, so a rule that wanted a read would fail `today` more often and filter the control toward its better runs.
- **The blinded lists.** One list per order, `lists/<order>.md`, holds each scored run's findings under a code, sorted by it, the Tasters in the recipe's order, a Taster's `riskLeft` under its own heading. A code is an HMAC of the run under a seed the folder keeps, so it stays the same as more runs come in. `codes.md` alone says which setup and run each code is, with each Taster's model and tokens and every failed run with why. The program scores nothing, and the key stays out of the repository,.
- **The table it prints** counts each setup's runs to score, failed goes and retries, and holds no code. A setup that retries more is a finding in itself. A list holds a run's first scored go.
- **What a Taster here is not given.** No check runs, so `{checks}` is left out, and a Taster may spend a `riskLeft` line on tests it could not see run. It is the same in every setup, so it biases no comparison, and `riskLeft` does not count for the key; whoever scores should know. No Finer or Gauger ran before it, and neither's out doc is an input of a Taster. The scratch Brewery holds no house yeast of its own, which is what the real batches had: the maintainer's Brewery holds no `house-yeast/`, and the repository's rules come with the base.
- **The procedure.** `node scripts/tasting-compare.ts --real [--runs <n>]` on a checkout with `claude`'s login; `--dry-run` scripts the Tasters and their transcripts too, each with one finding and one risk saying so, and spends no token. Its records stay under `.foedrum/tmp/tasting-compare/real/`. No number exists when this record is accepted: the maintainer runs it after the merge, `--runs 1` first.
- **A Brewery need do nothing:** nothing in one changes, and this runs only by hand in scratch folders.

## Consequences
- What a Taster's permissions allow was measured on 2026-11-06 with `claude` 2.1.310 on native Windows and the fake Messages API, in a worktree nested in the checkout. `Read` by a path outside and through `..`, `Grep` with a path outside or `..`, and `Glob` with a path outside or an absolute pattern were refused. `Glob` with `../outside/*` was permitted and found nothing. So today a run should not fail for this; the check holds on a version or a sandboxed level that differs, which this did not measure, and it is the issue's rule either way.
- A run leaves its scratch folder and, in Claude Code's config directory, a project folder per Taster. They stay until someone removes them.
- Three orders and three runs are a small sample, as ADR 0224 says of its change.
- The bar and the key are #879's, fixed before any run, and this record does not repeat them.

## Alternatives considered
- **A clone of the checkout as the scratch remote.** It would carry all of main.
- **A recipe per run, named by its setup, as the other modes have.** Six files of one text. The mode names its recipe instead.
- **A scored table.** ADR 0224's rule reads lines. A stale page or a missing decision record has none, so a person scores, blind.
- **Failing a run on a refused read outside.** It read nothing, and a Taster that tried is still a measurement of what it was given.
- **Moving the scratch folder out of the checkout.** Foedrum's sessions keep what they make inside the checkout, and the permissions and this check already hold.
