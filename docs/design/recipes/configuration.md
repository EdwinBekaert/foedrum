# Configuration files

Both are JSONC with a `$schema` reference for editor autocompletion; unknown fields are rejected.

**`foedrum.jsonc`** (`src/schemas/brewery-config.ts`, `schemas/foedrum.json`) maps each registered repository's checks to commands ([ADR 0023](../../adr/0023-language-independent-recipes.md)):

```jsonc
{
  "$schema": "./.foedrum/schemas/foedrum.json",                  // written by `foedrum init`
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
      "setup": { "command": "dotnet restore", "timeout": "15m" },  // before a check step's checks (ADR 0140)
      "tools": ["Bash(dotnet test*)", "Bash(dotnet build*)"],    // added to every brewer's allowlist
      "houseYeast": "repo",                                      // or "brewery" (ADR 0018)
      "alias": "billing",                                        // batches billing-<issue>
      "intake": { "labels": ["foedrum"] }                       // claim and brew its labelled issues
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
  A `tools` rule that reaches git with no fixed subcommand (`Bash(git *)`) is refused like a brewer's, but only when an attempt is planned, not when the file is loaded: each attempt for that repository then fails with `the brewer could not start` ([ADR 0062](../../adr/0062-brewers-never-allow-git-with-no-fixed-subcommand.md)).
  Neither the ceiling nor `tools` may name `gh` (`Bash(gh *)`, `Bash(gh*)`, `Bash(env gh *)`), which is refused when the file is loaded; a broad ceiling such as `Bash(*)` or `Bash(env *)` stays, and a `tools` rule that reaches `gh` in another spelling is refused when an attempt is planned ([ADR 0082](../../adr/0082-brewers-never-allow-gh.md)).
  So is a `tools` rule that is a `Write`, `MultiEdit`, `NotebookEdit` or `Glob` path rule ([ADR 0093](../../adr/0093-brewers-file-tool-rules-are-read-and-edit-rules-scoped-to-the-worktree.md)).
- Repository keys are `owner/name`, unique regardless of case.
- `intake` (`labels`, at least one, and an optional `milestone`) makes the intake claim and brew the repository's open issues that pass it (ADR 0043).
  It needs an `alias`: a lower-case letter, then letters and digits, at most 20, unique in the Brewery; the batch of a claimed issue is `<alias>-<issue>` ([ADR 0050](../../adr/0050-the-intake-of-target-repository-issues.md)).
  `foedrum doctor` reports a `foedrum.jsonc` that does not pass the schema.
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

**House-yeast rules** (`src/schemas/house-yeast.ts`, `schemas/house-yeast.json`) carry the frontmatter of [ADR 0018](../../adr/0018-house-yeast-layers.md): `id`, `scope` (`globs`, `language`, `lens`, all optional), `kind`, `source`, `created` (a date) and `status`.
