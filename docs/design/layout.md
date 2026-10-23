# Layout

**Foedrum repository:**

```
src/
  cli/          entry point and commands
  engine/       events, fold, store, state branch, scheduler, supervisor, executor
  brewers/      brewer loading, prompt assembly (ADR 0041), CLI invocation
  recipes/      schema and loading
  github/       client, auth, intake, projection
  workspace/    git (a non-interactive runner with timeouts) and worktrees
  platform/     OS differences: removal, path comparison, process trees ([cross-platform rules](platform/cross-platform.md))
  checks/       gravity readings, the red proof, the testsUnchanged guard (ADR 0078)
  evals/        flight, blind tasting, model watcher
  schemas/      zod schemas (source of types, validation and JSON Schema)
  formats/      JSONC and frontmatter readers (limits for untrusted input: 64 levels, 1 MiB; ADR 0020), TAP, JUnit XML and git diff readers
schemas/        JSON Schema files generated from src/schemas (npm run schemas)
defaults/       default brewers, recipes and tasting lenses
scripts/        development scripts: the check, the gate, the review's tools, npm run demo (a scratch Brewery brewed with Nip through serve's seams with the tests' fakes, and foedrum brew and resume; ADR 0097, ADR 0139); never shipped
plugin/         companion Claude Code plugin (Markdown commands and skills)
test/           unit, property, chaos, integration; helpers/ holds the fakes, never shipped (the package's files are src/, defaults/ and schemas/)
docs/
```

**A Brewery:**

```
foedrum.jsonc     the Brewery's owner/name (brewery) and GitHub API (githubApi); repositories (source, base, release signal, triage sources, intake filter and alias, check commands, test report, setup, toolchain allowlist; ADR 0023, ADR 0050), allow-listed users (users), concurrency, how often the intake polls (pollEvery), budgets, permission ceiling (schema so far: the Brewery, the GitHub API, users, concurrency and pollEvery (ADR 0068), source and base, checks, test report, setup, tools, house-yeast fallback, intake filter and alias, and ceiling; [configuration files](recipes/configuration.md); the ceiling: ADR 0026)
models.jsonc      model aliases, and an alias per brewer (updated by blind-tasting pull requests)
brewers/          custom and overriding brewers (*.md)
recipes/          custom and overriding recipes (*.jsonc)
lenses/           custom and overriding tasting lenses: diff/*.md review a diff, plan/*.md a plan (ADR 0143); a brewer input "lens:diff/<name>" reads one (ADR 0098)
house-yeast/      Brewery-layer rules, and repository-layer rules for repositories with the Brewery fallback ([house yeast](house-yeast.md))
.foedrum/         local (git-ignored): SQLite index (index.db; foedrum status and replay open it read-only), local.jsonc (this machine's work root and clones, ADR 0063), logs

Work root (outside the checkout, default ~/.foedrum/<owner>.<name>/): brewery.json (the Brewery it belongs to) and drivers/<owner>.lock (one per driver), ADR 0037; per repository <owner>.<name>/ with attempts/<batch>/<step>/<attempt> (worktrees), clone.git (managed clone) and git-dirs/ (a git directory per base fetch, ADR 0090 and ADR 0137; one a stopped call left goes at the first cleanup an hour on, ADR 0130); ADR 0029; state/ (the state branch's worktree) with state.lock (its writer lock, ADR 0107), and attempt-settings/<batch>/<step>/<attempt>.json, ADR 0059 and ADR 0063

Branch foedrum/state: batches/<id>/events.jsonl and out docs (<step>-<attempt>.md), events.jsonl for events without a batch; committed at every step boundary (ADR 0024)
```

**A target repository** receives only what its bottles bring, plus:

```
.foedrum/house-yeast/                repository-layer rules (one Markdown file per rule), committed in bottles ([house yeast](house-yeast.md))
refs/foedrum/claims/issues/<n>       the claim on an issue a Brewery took from it ([target-repository issues](intake/target-issues.md), ADR 0043)
foedrum/<owner>.<name>/<rest>        branches, prefixed with the Brewery that pushed them ([the state branch](engine/state-branch.md))
```

On a claimed issue it also gets the Brewery's assignee, the `foedrum:claimed` label until the claim is released, and claim and release comments ([target-repository issues](intake/target-issues.md)).
