# 0023. Default recipes are language-independent

Date: 2026-10-15 · Status: Accepted, amended by [0069](0069-check-steps-run-the-repositorys-commands-in-an-attempt-of-their-own.md) (how check steps run and record a skipped check) and [0140](0140-a-repository-s-setup-runs-before-a-check-step-s-checks-with-the-network.md)

## Context
Foedrum brews in the repositories an organisation already has: TypeScript, C#, Kotlin, Rust, Go, Python, often several of them in one order ([ADR 0013](0013-single-repo-sub-orders-bottles-and-releases.md)). Parts of the design already assume this. Red proof reads a TAP or JUnit XML report that each repository declares ([ADR 0017](0017-test-first-recipes-and-tasting-lenses.md)), Brett needs no mutation library because "a brewer works in any language", and house yeast rules can be scoped by language ([ADR 0015](0015-house-yeast.md), [ADR 0018](0018-house-yeast-layers.md)).

The principle itself was never decided, and the design has gaps where a language leaks in. Recipes name checks (`"check": ["typecheck", "lint", "test"]`), but nothing says where those names become commands. The only brewer allowlist example is `Bash(npm test*)`. The setup command is a brewer field, although it depends on the repository, not on the role. And nothing says what happens when a repository has no linter or no type checker.

## Decision
- **Default brewers, recipes and lenses never name a language, build tool or package manager.** Their prompts describe the craft (write a failing test, keep the change small, review for injection), not a toolchain. Language know-how comes from the target repository's own instructions (`context: repo`) and from house yeast scoped by language.
- **Recipes name abstract checks:** `build`, `typecheck`, `lint`, `format` and `test`. A Brewery's own recipes may still use a literal shell command in a `check` step for a repository-specific reading (for example an end-to-end suite); the default recipes do not.
- **Each registered repository maps the checks to commands** in `foedrum.jsonc`, next to what it already declares there: its `testReport`, its `setup` command (run once per worktree, with a timeout; it moves from the brewer to the repository), and the extra tool allowlist its brewers get for those commands (for example `Bash(dotnet test*)`). The engine composes a brewer's allowlist from the brewer's own role-level tools and the repository's toolchain entries, within the Brewery's permission ceiling.
- **A missing check is explicit, never guessed.** A repository marks a check it lacks as `null` ("not available"). A gravity reading skips an unavailable check and records the skip in the batch's events and status comment. A step that requires a check (red proof requires `test` with a report) stops the batch as Stuck (`environment`) at the start, naming the fix, as ADR 0017 already does for a missing test report. The engine never infers a command at run time.
- **Setup proposes, it does not guess.** `foedrum init` and `foedrum doctor` detect common ecosystems (npm and other Node package managers, .NET, Gradle, Maven, Cargo, Go, Python) from their manifest files and propose the check commands, setup and test report settings for the human to confirm. `doctor` also reports a declared command whose program is not installed.
- **The Flight proves it:** its samples cover at least three languages, TypeScript, C# and one of Kotlin or Rust, so a prompt change that only works for one ecosystem shows up in evaluation.

## Consequences
- Registering a repository takes a few more lines in `foedrum.jsonc`; `init` writes most of them. The `foedrum.jsonc` schema (#52) gets a per-repository `checks` section, and `setup` moves out of the brewer frontmatter.
- Brewer prompts lose toolchain shortcuts. Where a language needs specific advice, it goes into language-scoped house yeast or the repository's own instructions, where it can be measured and retired.
- A repository without a linter or type checker still works: the readings it has run, and the status comment shows which were skipped.
- Foedrum's own repository is just one registered TypeScript repository; dogfooding it does not make the defaults npm-specific.
- Toolchains must be installed on the machine that brews. Isolation levels ([ADR 0010](0010-cross-platform-and-isolation-levels.md)) do not provide them; `doctor` reports what is missing.

## Alternatives considered
- **Language-specific default recipes** (a TypeScript recipe, a .NET recipe, …): easier prompts, but the recipe count multiplies by languages, and a multi-repository order would need different recipes per sub-order for the same kind of work.
- **Detect commands at run time:** less configuration, but a wrong guess runs the wrong command unattended, and the result depends on what happens to be in the worktree. Detection belongs in `init`, where a human confirms it.
- **Let brewers find the commands themselves:** no configuration at all, but it costs tokens on every attempt, gives no deterministic gravity reading, and needs broad shell permissions.
