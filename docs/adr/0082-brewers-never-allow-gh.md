# 0082. Brewers never allow `gh`, and doctor says what the permissions-only level leaves open

Date: 2026-10-18 · Status: Accepted · Amends [0062](0062-brewers-never-allow-git-with-no-fixed-subcommand.md) (what a brewer's rules may reach, and what the permission ceiling refuses) and [0073](0073-github-only-through-gh-s-own-login.md) (brewers never reach `gh`, which it left to #204)

## Context
Since ADR 0073, Foedrum reaches GitHub only through the maintainer's `gh` login in the OS keyring. The engine is the only part that may use it. A brewer runs as the same OS user, so a brewer whose allowlist lets it run `gh` can act with that login: `gh pr merge`, `gh api -X DELETE`, or `gh auth token` to print the credential. ADR 0073 decided that the permission ceiling and a brewer's allowlist refuse `Bash(gh *)` and that doctor's isolation line says what is left, and recorded that neither was in place yet (#204). The review of #207 added check steps (ADR 0069): they run code a brewer may have written, as the same OS user.

The allowlist already fails closed on git's program word (ADR 0062): a whole shell, a star in the program word, a quoted or computed program word, and a wrapper with a star are refused, so the same reading of the program word serves `gh`.

## Decision
- **A brewer's `tools.allow` and the attempt settings refuse every shell rule that may start `gh`** (`BrewerAllowedTool`, `reachesGh` in `src/schemas/primitives.ts`), with any arguments: `gh` has no subcommand a brewer needs that is not the engine's. The program word is read as ADR 0062 reads it (`shellProgramOf`, shared with `reachesAnyGitCommand`), so the check refuses:
  - any program: a whole shell, a star in or right after the program word (`Bash(*)`, `Bash(g*)`), a program word with a quote, `&`, `$` or an assignment (`Bash('gh' *)`, `PowerShell(& gh *)`, `Bash(GH_HOST=x gh *)`), or in Bash a backslash (`Bash(g\h *)`);
  - `gh` by name or by a path whose last part is `gh`, also with an extension Windows runs (`Bash(gh *)`, `Bash(gh --version)`, `Bash(/usr/bin/gh *)`, `PowerShell(C:\Tools\gh.exe api user)`), case-insensitively and with `:*` read as ` *`;
  - a wrapper from ADR 0062's list with a star, or with `gh` after it (`Bash(xargs *)`, `Bash(env gh api user)`, `Bash(xargs gh)`).

  A program whose name only starts with `gh` stays allowed (`Bash(ghc --make Main)`), and so does `gh` as an argument (`Bash(npm run gh)`, `Bash(cat gh.txt)`).
- **The permission ceiling and a repository's `tools` refuse a rule that names `gh`** (`CeilingTool`, `namesGh`): `gh` by name or path, or a wrapper with `gh` after it, refused when `foedrum.jsonc` is loaded, so `foedrum doctor` and `foedrum serve` name the rule. They are not allowlists: a broad rule such as `Bash(*)` stays (ADR 0062), and a repository rule within it that reaches `gh` in another spelling is refused when an attempt is planned, as for git.
- **doctor's isolation advice says what the permissions-only level leaves open.** Under the `Isolation:` line, on every permissions-only level, doctor adds: a brewer or a check step runs as you here, so it can still ask the OS keyring for gh's login; and what closes that: WSL2 or the container level on native Windows and WSL 1, the sandboxed level (bubblewrap and socat) or the container level on Linux without them, the container level on an operating system without a sandbox. It is advice, not a problem: the level is the user's choice (ADR 0010). On the sandboxed level doctor says nothing about it.
- **What the rules cannot close.** As ADR 0062 says for a push, a rule cannot close a command that an allowed command runs in turn: a script behind `npm test` that a writing brewer can edit, `node -e`, `npm exec`, and a check step's commands, which run the repository's own code. git commands that talk to a remote (`git fetch`) ask git's credential helper, which on a Brewery set up as ADR 0073 says is `gh auth git-credential`. Only the OS user separates these from the login on the permissions-only level, which is why doctor says so; the sandboxed level, WSL2 and the container level keep them apart (ADR 0073).
- **Tests, unit only:** the rules refused and allowed in `test/unit/attempt-settings.test.ts`, the brewer file in `test/unit/brewer.test.ts`, the ceiling and a repository's tools in `test/unit/brewery-config.test.ts`, and the advice per platform in `test/unit/doctor.test.ts` and the report in `test/unit/cli.test.ts`. No test runs `claude`: the check is on the rules Foedrum writes, and how `claude` matches a rule against a command was checked for ADR 0062.

## Consequences
- A brewer file or a `foedrum.jsonc` that lets brewers run `gh` no longer loads. A brewer that needs something from GitHub gets it from the engine, through its inputs.
- ADR 0073's paragraph "Brewers never reach `gh`" is in place; its "Neither is in place yet" no longer holds.
- The permissions-only report has one more advice line; on native Windows it follows the WSL2 advice.

## Alternatives considered
- **Allow read-only `gh` subcommands (`gh pr view`, `gh issue view`):** they still use the maintainer's login, and `gh api` turns any of them into a write; reading GitHub for a brewer is the engine's job, through the order and inputs.
- **Run brewers and check steps with an empty `GH_CONFIG_DIR`:** `gh` would find no login there, but a process can set the variable back, so it would look like a guarantee it is not.
- **Refuse broad rules in the ceiling too (`Bash(*)`):** the ceiling bounds what a repository adds; what reaches an attempt is checked there, and ADR 0062 keeps `Bash(*)` in the ceiling.
- **Report the keyring as a problem in doctor:** it would show on every Windows machine without WSL2, where the permissions-only level is a valid choice for trusted repositories.
