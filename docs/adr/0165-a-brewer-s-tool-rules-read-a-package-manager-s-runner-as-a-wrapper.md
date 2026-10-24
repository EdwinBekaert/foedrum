# 0165. A brewer's tool rules read a package manager's runner as a wrapper

Date: 2026-10-24 · Status: Accepted · Amends [0062](0062-brewers-never-allow-git-with-no-fixed-subcommand.md) (the wrapper list takes in the package managers' runners, where it said the list does not grow for them) and [0082](0082-brewers-never-allow-gh.md) (the same reading for `gh`, the permission ceiling and a repository's `tools`)

## Context
A brewer's shell rules are refused when they may start git with no fixed subcommand or `gh` (ADR 0062, ADR 0082). The check reads each rule's program word, and a **wrapper**, a program that runs the rest of its line as a command, is refused with a star after it, with git or `gh` after it, or with text after it that cannot be read as written (`reachesAnyGitCommand`, `reachesGh` and `namesGh` in `src/schemas/primitives.ts`). `npx` is on the wrapper list. ADR 0062 named `npm exec`, `npm x`, `pnpm dlx`, `yarn exec` and `bunx` as programs out of its reach, and decided that the list does not grow to chase them.

#439 found where that leads. `configuration.md` tells a Brewery owner that `Bash(npx biome format --write *)` fails each attempt when it is planned, so the next rule an owner writes is `Bash(npm exec biome format --write *)`, which passes. So does `Bash(npm exec *)` under a ceiling of `Bash(npm *)`, the ceiling `configuration.md` shows. `npm exec -c '<command>'` runs any command, so a brewer steered by an injected issue can run `npm exec -c 'gh auth token'` under that rule (found while working on #432, checked on its branch with `attemptSettings`). The check refuses `npx` and passes `npx` under its other names, on the spelling a JavaScript toolchain meets first.

How the package managers read a subcommand, checked on 2026-10-24:

- **npm 11.19.0**, run on Windows 11 and read in its `lib/utils/cmd-list.js`. `deref` takes the exact command, then an alias (`x` → `exec`), then a unique abbreviation of a command or alias. So `npm exe -c 'echo x'` runs, and `npm ex` and `npm e` are `Unknown command` (`explain` and `explore` start the same way). Options before the subcommand are read: `npm --prefix . exec -c …`, `npm -s exec -c …` and `npm --loglevel=silent x -c …` all ran the command. `npm explore <package> -- <command>` runs a command in a package's folder. A word npm does not know is `Unknown command`, and `EXEC` in capitals is unknown too.
- **pnpm**, from its docs (pnpm.io/cli/exec, /cli/run, not run here): `pnpm exec` runs a shell command, and with `-c` runs it in a shell. The `exec` keyword "is optional when the command doesn't conflict with a built-in pnpm command" (`pnpm jest`), so a word pnpm does not know is run as a command. `pnpm dlx` runs a package from the registry, and `pnpx` is `pnpm dlx`.
- **yarn**, from yarnpkg.com/cli and /cli/run (not run here): `yarn exec` runs a shell script and `yarn dlx` a package. `yarn <name>` is `yarn run <name>`, which runs a script or else a dependency's binary of that name.
- **bun**, from bun.sh/docs/cli/bunx and /cli/run (not run here): `bunx` is `bun x`, which runs any program on its `PATH` (`bunx -p typescript sh -c "tsc --version"`). `bun run` falls back to "System commands: `bun run ls`". `bun <script>` runs a script, a file or a package's binary.

## Decision
- **The program words `npm`, `pnpm`, `yarn` and `bun` are read by their subcommand**, the first word after the program word, as git's is (ADR 0062):
  - an option, a quote or a star where the subcommand would be refuses the rule (`Bash(npm *)`, `Bash(npm --prefix . exec gh)`, `Bash(pnpm --filter app run build)`). An option may take a value, so the subcommand after it cannot be read;
  - a star right after part of a subcommand counts as every word it could become (`Bash(npm e*)` could be `exec`, `Bash(pnpm r*)` any word pnpm does not know).
- **A runner subcommand is read as a wrapper** from ADR 0062's list, with ADR 0082's reading: a star, git or `gh` after it, or text after it that cannot be read as written refuses it, and without any of these it stays allowed (`Bash(npm exec biome format --write)`, as `Bash(npx tsc)`). The runners:
  - **npm**: `x`, and every word that starts `exec` or `explore` (`exe`, `exec`, `explo`, `explore`): npm resolves a unique abbreviation, so reading the prefixes covers each version's table without copying it;
  - **pnpm** and **yarn**: `exec` and `dlx`;
  - **bun**: `x` and `run`, since `bun run` falls back to any command on the `PATH`;
  - and as program words, **`bunx`** and **`pnpx`**, next to `npx`.
- **pnpm, yarn and bun run a word they don't know as a command**, so any other subcommand of theirs is read as the program word of what follows it. `Bash(pnpm git -C . push)` is read as `Bash(git -C . push)` and refused, and so is `Bash(yarn gh pr list)`. `Bash(bun exec *)` is read as `Bash(exec *)`, a wrapper with a star, and refused. `Bash(pnpm run *)` and `Bash(yarn run lint)` are read as a program named `run`, which is neither git, `gh` nor a wrapper, and stay allowed. npm's other subcommands are plain arguments, as before (`Bash(npm run *)`, `Bash(npm ci)`, `Bash(npm test)`), since npm runs no word it does not know.
- **Everywhere the program word is read**: a brewer's `tools.allow` when its file is loaded, the attempt settings, so a repository's `tools` fail the attempt when it is planned with `the brewer could not start` (ADR 0062), and `namesGh` for the permission ceiling and a repository's `tools` when `foedrum.jsonc` is loaded (`Bash(npm exec gh *)`, `Bash(pnpm gh *)`). The ceiling is not an allowlist, so `Bash(npm *)` stays allowed there, as `Bash(*)` does (ADR 0062).
- **Why the list grows here, against ADR 0062.** These are `npx` under other names, the wrapper JavaScript tool rules are written with, and the docs steer an owner from `npx` to them. That is the test for the next addition: an alias of a wrapper already on the list. A program that only *can* run a command still stays out (`node -e`, `python -c`, `find -exec`), as ADR 0062 decided.
- **What it still cannot close**, unchanged from ADR 0062 and ADR 0082: what an allowed command runs in turn, such as the scripts behind `npm run` that a writing brewer can edit, a dependency's binary behind `yarn run`, `npm install`'s lifecycle scripts, the registry package `npm init <name>` and `npm create` run, an npm `script-shell` from a configuration file, and `node -e`. An alias that a later version of a package manager adds is not read until the list takes it in. The isolation level and the check of the remote (ADR 0106, ADR 0109) are what hold for these.
- **Case does not count**, as ADR 0062 reads the program word. `Bash(npm EXEC *)` is refused, although npm does not know `EXEC`.
- **Tests, unit only, red first** (ADR 0082's places: `test/unit/attempt-settings.test.ts`, `test/unit/brewer.test.ts`, `test/unit/brewery-config.test.ts`):
  - refused: one case per form, `npm exec`, `npm x`, `npm exe`, `npm explore`, `npm --prefix . exec`, `npm *`, `npm e*`, `pnpm exec`, `pnpm dlx`, `pnpx`, `pnpm git …`, `yarn exec`, `yarn dlx`, `bunx`, `bun x`, `bun run *`, with a star, with git or with `gh` after it;
  - allowed: `Bash(npm run lint)`, `Bash(npm run *)`, `Bash(npm ci)`, `Bash(npm exec biome format --write)`, `Bash(pnpm run *)` and `Bash(bun run lint)`.

  No test runs `claude` or a package manager: the check reads the rules Foedrum writes, and how `claude` matches a rule was checked for ADR 0062.

## Consequences
- A brewer file with `Bash(npm *)`, `Bash(npm exec *)` or `Bash(pnpm *)` no longer loads, and such a rule in a repository's `tools` fails each attempt for that repository, naming ADR 0062 and ADR 0082. ADR 0062 already advised against `Bash(npm *)`; now the check refuses it.
- pnpm's monorepo form with the filter in front (`pnpm --filter app run build`) is refused. Write a script in `package.json` for it, and allow `Bash(pnpm run <script>)`.
- `configuration.md` names `npm exec` next to `npx` in its formatting advice. The design pages change with the code (#439).
- The Brewery Foedrum brews itself with allows `npm run *` and `node --test *` (#432), which stay allowed.

## Alternatives considered
- **Keep ADR 0062's list as it is.** The check would keep refusing `npx` and passing `npm exec`, which the docs steer to. That is the spelling a toolchain rule is most likely to use.
- **Refuse `npm`, `pnpm`, `yarn` and `bun` with any star.** That also refuses `Bash(npm run *)`, which tool rules for format and lint need.
- **Read past the options to the subcommand** (`npm --prefix . exec`). The check would need each package manager's options that take a value, per version. Failing closed costs a rule that can be written another way.
- **Copy npm's abbreviation table.** It changes between versions. Reading the words that start `exec` or `explore` covers every abbreviation of the two.
- **A deny rule such as `Bash(npm exec *)`.** ADR 0062 shows that a deny rule matches the command as written, so `npm --prefix . exec` and `npm exe` get past it.
