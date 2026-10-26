# Configuration files

Both are JSONC with a `$schema` reference for editor autocompletion; unknown fields are rejected.

**`foedrum.jsonc`** (`src/schemas/brewery-config.ts`, `schemas/foedrum.json`) maps each registered repository's checks to commands ([ADR 0023](../../adr/0023-language-independent-recipes.md)):

```jsonc
{
  "$schema": "./.foedrum/schemas/foedrum.json",                  // for editors; `foedrum init` writes none yet
  "permissionCeiling": ["Bash(npm *)", "Bash(dotnet *)"],       // the most a repository may add
  "repositories": {
    "acme/billing": {
      "checks": {                                                // all five, a command or null
        "build": "dotnet build",
        "typecheck": null,                                       // not available: skipped and recorded
        "lint": null,
        "format": { "run": "dotnet format --verify-no-changes", "windows": "…" },
        "test": "dotnet test --logger junit"
      },
      "testReport": { "format": "junit", "path": "tests/TestResults/results.xml" },
      "setup": { "command": "dotnet restore", "timeout": "15m" },  // before a brewer attempt and a check step's checks (ADR 0163)
      "tools": ["Bash(dotnet test*)", "Bash(dotnet build*)"],    // added to every brewer's allowlist
      "houseYeast": "repo",                                      // or "brewery" (ADR 0018)
      "alias": "billing",                                        // batches billing-<issue>
      "intake": { "labels": ["foedrum"] },                      // claim and brew its labelled issues
      "sensitivePaths": [".github/workflows/**", "src/Auth/**"]  // named when a batch touches them (ADR 0201)
    }
  }
}
```

- `checks` requires all five keys, so a missing check is always an explicit `null`.
  A command is one line, or `{ "run", "windows", "macos", "linux" }` with per-OS overrides.
- `testReport` is `{ "format": "tap" }` (the test command writes TAP to standard output), `{ "format": "tap", "path": … }` or `{ "format": "junit", "path": … }`; the path is relative to the worktree, never leaves it, and uses only file names Windows can create (no device names such as `con`, no trailing dot or space, none of `<>:"|?*` or control characters).
  A test report needs a `test` command.
- Every `tools` rule must stay within `permissionCeiling`, which fails closed ([ADR 0026](../../adr/0026-how-a-permission-ceiling-covers-a-rule.md)).
  A ceiling rule covers the same tool when it has no specifier, when its specifier is the rule's, or when its specifier, read as a glob, matches the rule's specifier (`Bash(dotnet *)` covers `Bash(dotnet test*)`, not the other way round).
  In a `Bash` or `PowerShell` rule a `*` never stands for a shell operator or grouping (`;&|` backtick `$<>(){}`; PowerShell runs a parenthesised argument), so `Bash(npm *)` does not cover `Bash(npm test && curl …)`.
  In a path rule (`Read`, `Edit`, `Write`, `MultiEdit`, `NotebookEdit`) a `*` stays within one folder and `**` crosses folders, so `Edit(docs/*)` does not cover `Edit(docs/**)`.
  A rule with a `..` segment, or a path rule anchored at `/` or `~`, is only covered by the same specifier or a bare tool.
  Without a ceiling, a repository adds no tools.
  `AskUserQuestion` is never allowed.
  A `tools` rule that reaches git with no fixed subcommand (`Bash(git *)`, `Bash(npm exec *)`) is refused like a brewer's, but only when an attempt is planned, not when the file is loaded: each attempt for that repository then fails with `the brewer could not start` ([ADR 0062](../../adr/0062-brewers-never-allow-git-with-no-fixed-subcommand.md), [ADR 0165](../../adr/0165-a-brewer-s-tool-rules-read-a-package-manager-s-runner-as-a-wrapper.md)); the ceiling may still hold `Bash(npm *)`.
  Neither the ceiling nor `tools` may name `gh` (`Bash(gh *)`, `Bash(gh*)`, `Bash(env gh *)`, `Bash(npm exec gh *)`, `Bash(pnpm gh *)`), which is refused when the file is loaded; a broad ceiling such as `Bash(*)` or `Bash(env *)` stays, and a `tools` rule that reaches `gh` in another spelling is refused when an attempt is planned ([ADR 0082](../../adr/0082-brewers-never-allow-gh.md), [ADR 0165](../../adr/0165-a-brewer-s-tool-rules-read-a-package-manager-s-runner-as-a-wrapper.md)).
  So is a `tools` rule that is a `Write`, `MultiEdit`, `NotebookEdit` or `Glob` path rule ([ADR 0093](../../adr/0093-brewers-file-tool-rules-are-read-and-edit-rules-scoped-to-the-worktree.md)).
- `setup` runs in the worktree of every attempt of a brewer with a shell (a `Bash` or `PowerShell` rule, its own or from `tools`), before the brewer, and of every check step, before its checks, in the check sandbox with the network kept ([ADR 0158](../../adr/0158-a-repository-s-setup-runs-in-the-check-sandbox-with-the-network-kept.md), [ADR 0163](../../adr/0163-a-repository-s-setup-runs-before-a-brewer-attempt.md)).
  So a brewer can run the repository's format, lint, typecheck and tests itself, which the default Gauger and Cellarman do when `tools` allows the commands; the check step after them stays the gate.
  Foedrum's own repository allows them within a ceiling that names them and nothing broader:

  ```jsonc
  "permissionCeiling": ["Bash(npm run *)", "Bash(node --test *)"],
  "repositories": {
    "edwinbekaert/foedrum": {
      "setup": { "command": "npm ci", "timeout": "10m" },
      "tools": [
        "Bash(npm run lint)",
        "Bash(npm run typecheck)",
        "Bash(npm run lint -- --write *)",                        // format and fix the files it changed
        "Bash(node --test *)"                                     // the test files it touched
      ]
    }
  }
  ```

  A brewer's command runs in Claude Code's sandbox where the isolation level is sandboxed (ADR 0010); a command `tools` does not allow is denied and counts toward the brewer's denials.
  Format through the repository's own script (`npm run lint -- --write <path>`), not `npx` or `npm exec`: they run the rest of their line as a command, so `Bash(npx biome format --write *)` and `Bash(npm exec biome format --write *)` pass the ceiling but fail each attempt when it is planned, since their star could start git or gh ([ADR 0062](../../adr/0062-brewers-never-allow-git-with-no-fixed-subcommand.md), [ADR 0082](../../adr/0082-brewers-never-allow-gh.md), [ADR 0165](../../adr/0165-a-brewer-s-tool-rules-read-a-package-manager-s-runner-as-a-wrapper.md)).
- Repository keys are `owner/name`, unique regardless of case.
- `intake` (`labels`, at least one, and an optional `milestone`) makes the intake claim and brew the repository's open issues that pass it (ADR 0043).
  It needs an `alias`: a lower-case letter, then letters and digits, at most 20, unique in the Brewery; the batch of a claimed issue is `<alias>-<issue>` ([ADR 0050](../../adr/0050-the-intake-of-target-repository-issues.md)).
  `foedrum doctor` reports a `foedrum.jsonc` that does not pass the schema.
- `sensitivePaths` lists path globs, relative to the repository with `/` between folders, as `posix.matchesGlob` reads them, case and all, except that a wildcard also matches a name that starts with a dot (`src/auth/**` covers `src/auth/.env`); there are no defaults ([ADR 0201](../../adr/0201-a-repository-names-its-sensitive-paths-and-a-batch-that-touches-one-says-so.md)).
  A glob that is blank, starts at `/` or `!`, holds a `\` or has a `.` or `..` segment is refused.
  When a batch's pull request is pushed, the files its change adds, alters or deletes (a rename at both paths), from where its change starts to the commit pushed, are matched once, and the push's ledger result keeps how many matched and the first 50 ([openPullRequest](open-pull-request.md)).
  The status comment then names the first 10 in one line after its steps, `Touches sensitive paths: …`, with a count of the rest, in every lane from then on.
  It is a fact for the person who merges, never an approval or a block: tasting does not change.
- Durations (`timeout`, `deadline`) are a whole number with `s`, `m`, `h` or `d`: `"90s"`, `"30m"`, `"3d"`.

**`models.jsonc`** (`src/schemas/models.ts`, `schemas/models.json`) maps the aliases brewers name in `model` to a model id or family, and optionally gives one brewer another alias, as blind tasting does:

```jsonc
{
  "$schema": "./.foedrum/schemas/models.json",
  "models": { "builder": "claude-sonnet-5-5", "reviewer": "opus", "candidate": "claude-opus-5-5[1m]" },
  "brewers": { "cellarman": "candidate" }                       // must name an alias above
}
```

The file is optional: Foedrum's own `defaults/models.jsonc` maps `builder` to `sonnet`, and the Brewery's `models` replace its entries by alias and add to them, while `brewers` comes from the Brewery's file only and may name a default alias ([ADR 0153](../../adr/0153-foedrum-s-defaults-map-their-own-model-aliases.md)).

Model ids reach the `claude` command line, so they are limited to lower-case letters, digits, `.`, `_`, `:` and `-` (plus a `[1m]` suffix), and never start with `-`.

**House-yeast rules** (`src/schemas/house-yeast.ts`, `schemas/house-yeast.json`) carry the frontmatter of [ADR 0018](../../adr/0018-house-yeast-layers.md): `id`, `scope` (`globs`, `language`, `lens` by its name or as `diff/<name>` or `plan/<name>`, all optional), `kind`, `source`, `created` (a date) and `status`.
