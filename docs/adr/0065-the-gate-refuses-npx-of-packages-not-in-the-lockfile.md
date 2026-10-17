# 0065. The local gate refuses npx of packages that are not in the lockfile

Date: 2026-10-17 · Status: Accepted · Amends [0045](0045-the-local-gate-reads-commands-as-the-shells-would.md) (what the gate reads) and [0056](0056-the-gate-pre-filter-reads-the-command.md) (the pre-filter's words)

## Context
Sessions kept formatting files with `npx prettier --write …` (#43, #79, #92, #167). Prettier is not in `package-lock.json`, so `npx` downloads its latest version and runs it with no lockfile, no `min-release-age` and no review: a way around the dependency policy ([ADR 0004](0004-built-in-first-dependency-policy.md)) that nothing caught. It also formats differently from Biome, which is how #167 briefly broke a commit. `npm exec`, `pnpm dlx`, `yarn dlx` and `bunx` do the same. The gate already read every Bash and PowerShell command and skipped `npx` as a wrapper word; it guarded pushes, merges and pull requests only.

## Decision
- **Package runners.** `npx`, `npm exec` (and `npm x`), `pnpm dlx` (and `pnpx`), `yarn dlx`, `bunx` (and `bun x`) are read as wrappers, also by their Windows shims (`npx.cmd`, `npx.ps1`), wherever the gate finds a command: through other wrappers, shells, evaluators and compound commands, in both dialects ([ADR 0045](0045-the-local-gate-reads-commands-as-the-shells-would.md)). The program each one runs, and the value of each `-p`/`--package` option, is a package it would run.
- **Only binaries the lockfile installed pass.** Each such package must be a plain name (letters, digits, `.`, `_`, `-`) that exists as `node_modules/.bin/<name>` in the package around the hook's working directory: the nearest folder up with a `package.json`, as npm finds it. A version (`prettier@3`), a scope (`@biomejs/biome`), a path or a name computed at run time is refused without touching the file system. Otherwise the command is blocked with one line: `` `npx <name>` would download a package that isn't in package-lock.json. Use the project's tools: `npm run lint -- --write` formats with Biome.``
- **Not after a change of directory.** The check looks where the command starts, and npx looks where it runs. So a package runner in a command that also runs `cd`, `chdir`, `pushd`, `Set-Location`, `sl` or `Push-Location` is blocked with one line, even when the binary is installed: run it as a command of its own, from the folder whose `node_modules` it uses.
- **An injected check.** Whether a binary is installed is a function passed to `precheck`, so the unit tests use a fake (ADR 0021); the hook passes one that reads the file system. Without one, every package runner is refused.
- **The order.** The refusals come after the gate's own blocked forms (a force push stays a force push) and before `gh pr ready`, the HEAD check and `npm run check`.
- **The pre-filter grows.** `npx`, `npm`, `dlx` and `bun` join the words that send a command to the parser ([ADR 0056](0056-the-gate-pre-filter-reads-the-command.md)).

## Consequences
- `npx prettier` and its relatives are refused with the way to format instead; `npx biome check` and `npx tsc` still run, since npx finds them in `node_modules/.bin` without downloading.
- Every command that mentions `npm` (`npm run check`, `npm test`) is now parsed. The parser loads no module and costs well under a millisecond for such a command; only a package runner reads the file system.
- `npm exec` with npm options before `exec` (`npm --prefix x exec …`), `pnpm dlx --shell-mode`, a directory given another way (`env -C`, `Start-Process -WorkingDirectory`) and the scaffolding commands (`npm init <x>` and `npm create <x>`, `pnpm`, `yarn` and `bun create`), which fetch a `create-<x>` package to start a new project rather than run a tool in this one, are not covered; the gate guards against mistakes by sessions, not a determined adversary (ADR 0045).
- `cd <dir> && npx tsc` is refused even inside the checkout: run npx from the folder, as the gate's push check already asks of `git push`.
- A wrapped push such as `npx git push` is now refused as a download too, unless its force or delete form is blocked first; `npm exec -- git push -f` is now read as the force push it is.

## Alternatives considered
- **A deny rule in `.claude/settings.json` for `npx prettier`:** names one package, and rules see only the start of a command.
- **Refuse every package runner:** simpler, but `npx biome`, `npx tsc` are fine and in use.
- **Check `node_modules/<package>` instead of `.bin`:** handles scoped names, but a package name is not the program npx runs, and `.bin` is where npx looks for an installed binary.
