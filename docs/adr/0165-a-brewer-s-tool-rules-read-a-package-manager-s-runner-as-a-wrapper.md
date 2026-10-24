# 0165. A brewer's tool rules read a package manager's runner as a wrapper

Date: 2026-10-24 · Status: Accepted · Amends [0062](0062-brewers-never-allow-git-with-no-fixed-subcommand.md) (the wrapper list takes in the package managers' runners, where it said the list does not grow for them; a PowerShell program word drops `.ps1`; a wrapper's command is read after `=` too) and [0082](0082-brewers-never-allow-gh.md) (the same reading for `gh`, the permission ceiling and a repository's `tools`; `npm exec` leaves its list of what the rules cannot close)

## Context
A brewer's shell rules are refused when they may start git with no fixed subcommand or `gh` (ADR 0062, ADR 0082). The check reads each rule's program word, and a **wrapper**, a program that runs the rest of its line as a command, is refused with a star after it, with git or `gh` after it, or with text after it that cannot be read as written (`reachesAnyGitCommand`, `reachesGh` and `namesGh` in `src/schemas/primitives.ts`). `npx` is on the wrapper list. ADR 0062 named `npm exec`, `npm x`, `pnpm dlx`, `yarn exec` and `bunx` as programs out of its reach, and decided that the list does not grow to chase them.

#439 found where that leads. `configuration.md` tells a Brewery owner that `Bash(npx biome format --write *)` fails each attempt when it is planned, so the next rule an owner writes is `Bash(npm exec biome format --write *)`, which passes. So does `Bash(npm exec *)` under a ceiling of `Bash(npm *)`, the ceiling `configuration.md` shows. `npm exec -c '<command>'` runs any command, so a brewer steered by an injected issue can run `npm exec -c 'gh auth token'` under that rule (found while working on #432, checked on its branch with `attemptSettings`). The check refuses `npx` and passes `npx` under its other names, on the spelling a JavaScript toolchain meets first.

The review of this record found two more ways past the same reading, for `npx` today, checked with `BrewerAllowedTool`: `PowerShell(npx.ps1 *)` loads, since `.ps1` is not among the extensions the program word drops, and npm, pnpm and yarn ship `.ps1` shims. `Bash(npx --call=gh auth token)` and `Bash(npx --call=git -C . push)` load, since git and `gh` are found only after a space or a quote, never after `=`.

This improves a second layer of the trust-boundaries row "A brewer reaching outside its worktree" (ADR 0062) and adds none.

How the package managers read a subcommand, checked on 2026-10-24:

- **npm 11.19.0**, run on Windows 11, read in its `lib/utils/cmd-list.js`, and its `deref` called for 23 words in the review. `deref` takes the exact command, then an alias (`x` → `exec`), then a unique abbreviation of a command or alias. So `exe`, `explo` and `explor` resolve, and `npm exe -c 'echo x'` runs. `e`, `ex`, `exp`, `expl` and `execute` are `Unknown command` (`explain` and `explore` start the same way), and `EXEC` and `Exec` are unknown too. Options before the subcommand are read: `npm --prefix . exec -c …`, `npm -s exec -c …` and `npm --loglevel=silent x -c …` all ran the command. `npm explore <package> -- <command>` runs a command in a package's folder. npm runs no word it does not know.
- **pnpm**, from its docs (pnpm.io/cli/exec, /cli/run, not run here): `pnpm exec` runs a shell command, and with `-c` runs it in a shell. The `exec` keyword "is optional when the command doesn't conflict with a built-in pnpm command" (`pnpm jest`), so a word pnpm does not know runs as `pnpm exec <word>`: `pnpm sh`, `pnpm bash` and `pnpm npx` are `pnpm exec sh` and so on. `pnpm dlx` runs a package from the registry, and `pnpx` is `pnpm dlx`.
- **yarn**, from yarnpkg.com/cli and /cli/run (not run here): `yarn exec` runs a shell script and `yarn dlx` a package. `yarn <name>` is `yarn run <name>`, which runs a script or else a dependency's binary of that name. `yarnpkg` is yarn's second program name (yarn 1, and corepack's shim).
- **bun**, from bun.sh/docs/cli/bunx and /cli/run (not run here): `bunx` is `bun x`, which runs any program on its `PATH` (`bunx -p typescript sh -c "tsc --version"`). `bun run` falls back to "System commands: `bun run ls`". `bun <script>` runs a script, a file or a package's binary.
- **corepack**, which ships with Node 24: `corepack pnpm …` and `corepack yarn …` run that package manager, and `Bash(corepack *)` loads today.

## Decision
- **The program words `npm`, `pnpm`, `yarn` (and `yarnpkg`, read as `yarn`) and `bun` are read by their subcommand**, the first word after the program word, as git's is (ADR 0062). Each is read by name or path, also with an extension Windows runs, as ADR 0062 reads git (`Bash(/usr/bin/npm exec *)`, `PowerShell(npm.cmd exec *)`):
  - an option, a star, or a subcommand word with anything but letters, digits, `.`, `_` and `-` refuses the rule: a quote, a backslash, `$`, a backtick, a glob or a brace (`Bash(npm *)`, `Bash(npm --prefix . exec gh)`, `Bash(pnpm --filter app run build)`, `Bash(npm ex\ec *)`, ``PowerShell(npm e`xec *)``). An option may take a value, so the subcommand after it cannot be read, and the shell turns `ex\ec`, `$'exec'` or `{exec,}` into `exec`;
  - a star right after part of a subcommand counts as every word it could become (`Bash(npm e*)` could be `exec`, `Bash(pnpm r*)` any word).
- **A runner subcommand is read as a wrapper** from ADR 0062's list, with ADR 0082's reading: a star, git or `gh` after it, or text after it that cannot be read as written refuses it, and without any of these it stays allowed (`Bash(npm exec biome format --write)`, as `Bash(npx tsc)`). The runners:
  - **npm**: `x`, and every word that is the start of `exec` or `explore` (`e`, `ex`, `exe`, `exec`, `exp` … `explore`). npm resolves a unique abbreviation, and refusing the shorter, unknown ones costs nothing;
  - **pnpm** and **yarn**: `exec` and `dlx`;
  - **bun**: `x` and `run`, since `bun run` falls back to any command on the `PATH`;
  - and as program words, **`bunx`** and **`pnpx`**, next to `npx`.
- **Any other subcommand of pnpm, yarn or bun, a built-in one too, is read as the program word of what follows it, with every reading above.** pnpm runs a word it does not know as `pnpm exec`, and yarn and bun run it as a script or a package's binary, so the check does not keep their command tables. `Bash(pnpm git -C . push)` is read as `Bash(git -C . push)` and refused, and so are `Bash(yarn gh pr list)`, `Bash(pnpm sh *)` and `Bash(pnpm npm exec *)`. `Bash(bun exec *)` is read as `Bash(exec *)`, a wrapper with a star, and refused. `Bash(pnpm run *)` and `Bash(yarn run lint)` are read as a program named `run`, which is neither git, `gh` nor a wrapper, and stay allowed. npm's other subcommands are plain arguments, as before (`Bash(npm run *)`, `Bash(npm ci)`, `Bash(npm test)`).
- **`corepack` is read the same way**: its next word is the program word of what follows it, so `Bash(corepack pnpm exec *)` and `Bash(corepack *)` are refused, and `Bash(corepack enable)` stays allowed.
- **Two gaps in the reading close for every wrapper, `npx` included:**
  - a PowerShell rule's program word also drops `.ps1`, so `PowerShell(npx.ps1 *)` is read as `npx` and `PowerShell(npm.ps1 exec *)` as `npm`;
  - git or `gh` after a wrapper is found after `=` too (`Bash(npx --call=gh auth token)`, `Bash(npm exec --call=git -C . push)`, `Bash(env --split-string=gh auth token)`). An option after a runner stays allowed otherwise (`Bash(npx -y tsc)`).
- **Everywhere the program word is read**: a brewer's `tools.allow` when its file is loaded, and the attempt settings, so a repository's `tools` fail the attempt when it is planned with `the brewer could not start` (ADR 0062). The same reading also feeds `namesGh` for the permission ceiling and a repository's `tools` when `foedrum.jsonc` is loaded (`Bash(npm exec gh *)`, `Bash(pnpm gh *)`). The ceiling is not an allowlist, so `Bash(npm *)` and `Bash(pnpm *)` stay allowed there, as `Bash(*)` does (ADR 0062).
- **Why the list grows here, against ADR 0062.** The test for an addition: a package manager's subcommand that runs the rest of its line as a command, as `npx` does (`npm exec`, `npm explore … --`, `bun run`'s fallback to the `PATH`), or another name for a wrapper already on the list (`bunx`, `pnpx`). These are the wrappers JavaScript tool rules are written with, and the docs steer an owner from `npx` to them. A program that only *can* run a command still stays out (`node -e`, `python -c`, `find -exec`), as ADR 0062 decided.
- **What it still cannot close**, unchanged from ADR 0062 and ADR 0082, without `npm exec`:
  - what an allowed command runs in turn: the scripts behind `npm run` that a writing brewer can edit, a dependency's binary behind `yarn run`, and `npm install`'s lifecycle scripts;
  - an npm `script-shell`, `editor` or `browser` from a configuration file or the command line (`npm run x --script-shell=…` under `Bash(npm run *)`, `npm edit`, `npm docs`);
  - the registry package that `npm init <name>`, `npm create`, `pnpm create`, `yarn create` and `bun create` run;
  - `node -e`;
  - an alias that a later version of a package manager adds, until the list takes it in.

  The isolation level (the sandbox with the attempt settings, `docs/trust-boundaries.md`) and a brewer's git holding no push credential (ADR 0109, ADR 0133) are what hold for these.
- **Case does not count.** `PowerShell(npm EXEC *)` matches `npm exec`, since PowerShell rules match without case (ADR 0062), so it is refused. So is `Bash(npm EXEC *)`, which npm would not run.
- **Tests, unit only, red first** (ADR 0082's places: `test/unit/attempt-settings.test.ts`, `test/unit/brewer.test.ts`, `test/unit/brewery-config.test.ts`):
  - **refused**, one case per form, with a star, with git or with `gh` after it:
    - npm: `npm exec`, `npm x`, `npm exe`, `npm explo`, `npm explore`, `npm EXEC`, `npm --prefix . exec`, `npm *`, `npm e*`, `npm ex\ec *` and ``PowerShell(npm e`xec *)``, `/usr/bin/npm exec *`, `PowerShell(npm.cmd exec *)`, `PowerShell(npm.ps1 exec *)`;
    - pnpm, yarn and bun: `pnpm exec`, `pnpm dlx`, `pnpx`, `pnpm git …`, `pnpm sh *`, `pnpm npm exec *`, `pnpm --filter app run build`, `yarn exec`, `yarn dlx`, `yarnpkg dlx *`, `yarn gh pr list`, `bunx`, `bun x`, `bun run *`, `bun exec *`;
    - corepack and the two gaps: `corepack *`, `corepack pnpm exec *`, `PowerShell(npx.ps1 *)`, `npx --call=gh auth token`, `npm exec --call=gh auth token`, `env --split-string=gh auth token`;
  - **allowed**: `Bash(npm run lint)`, `Bash(npm run *)`, `Bash(npm ci)`, `Bash(npm exec biome format --write)`, `Bash(npx -y tsc)`, `Bash(pnpm run *)`, `Bash(yarn run lint)`, `Bash(bun run lint)` and `Bash(corepack enable)`;
  - **in the ceiling** (`test/unit/brewery-config.test.ts`): `Bash(npm *)` and `Bash(pnpm *)` load, and `Bash(npm exec gh *)` and `Bash(pnpm gh *)` are refused.

  No test runs `claude` or a package manager: the check reads the rules Foedrum writes, and how `claude` matches a rule was checked for ADR 0062.

## Consequences
- A brewer file with `Bash(npm *)`, `Bash(npm exec *)` or `Bash(pnpm *)` no longer loads, and such a rule in a repository's `tools` fails each attempt for that repository, naming ADR 0062 and ADR 0082. ADR 0062 already advised against `Bash(npm *)`; now the check refuses it.
- pnpm's monorepo form with the filter in front (`pnpm --filter app run build`) is refused. Write a script in `package.json` for it, and allow `Bash(pnpm run <script>)`.
- `Bash(bun run *)` is refused, since `bun run` falls back to the `PATH`. Allow each script (`Bash(bun run lint)`), or `bun test`.
- `configuration.md` will name `npm exec` next to `npx` in its formatting advice, with the code (#439).
- The Brewery Foedrum brews itself with allows `npm run *` and `node --test *` (#432), which stay allowed.

## Alternatives considered
- **Keep ADR 0062's list as it is.** The check would keep refusing `npx` and passing `npm exec`, which the docs steer to. That is the spelling a toolchain rule is most likely to use.
- **Refuse `npm`, `pnpm`, `yarn` and `bun` with any star.** That also refuses `Bash(npm run *)`, which tool rules for format and lint need.
- **Read past the options to the subcommand** (`npm --prefix . exec`). The check would need each package manager's options that take a value, per version. Failing closed costs a rule that can be written another way.
- **Copy npm's abbreviation table.** It changes between versions. Reading every start of `exec` or `explore` covers every abbreviation of the two.
- **Only the runner list for pnpm, yarn and bun, without reading their other words** (the necessity lens of the review). `Bash(pnpm sh *)`, `Bash(pnpm bash *)` and `Bash(pnpm npx *)` would load, and pnpm runs them as `pnpm exec sh` and so on: `npx` under another name.
- **Refuse any option after a runner**, to close `--call=gh`. That refuses `Bash(npx -y tsc)`. Reading after `=` closes the spelling and keeps the rule.
- **Leave `.ps1` and `=` to separate issues.** They are gaps in the same reading, for `npx` today, and the brew of this record changes that reading anyway.
- **A deny rule such as `Bash(npm exec *)`.** ADR 0062 shows that a deny rule matches the command as written, so `npm --prefix . exec` and `npm exe` get past it.
