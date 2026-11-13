# 0390. `foedrum init` offers the shim only from a checkout

Date: 2026-11-13 · Status: Accepted · Amends [0210](0210-foedrum-init-writes-the-foedrum-command-into-a-user-folder-on-the-path.md) (init offers the `foedrum` command only from a checkout), [0377](0377-the-package-ships-the-javascript-tsc-emits-and-ci-starts-the-installed-tarball.md) (the installed package writes no shim) and [0212](0212-foedrum-init-takes-every-answer-as-an-option-and-foedrum-init-asks-them-in-a-session.md) (from the package there is no shim question to ask, or to refuse under `--no-input`)

## Context
[ADR 0210](0210-foedrum-init-writes-the-foedrum-command-into-a-user-folder-on-the-path.md) has `foedrum init` offer a shim, a `foedrum` command in a user folder on the PATH that runs the checkout's `main.ts`, and says that after M3 `npx foedrum` replaces it.
[ADR 0377](0377-the-package-ships-the-javascript-tsc-emits-and-ci-starts-the-installed-tarball.md) has the shim run `main` beside the module that runs (`mainBeside`), `main.js` from the package, and left to the publish whether an installed package writes a shim at all.
From the package, that `main.js` lies in npx's cache under `npx foedrum init`, which npm may clear, so the shim would break later with no error when it is written.
Under `npm install --global foedrum`, npm's own `foedrum` is on the PATH already, and a shim would stand in its way.
The maintainer decided on #1030 (2026-11-13) that init offers the shim only from a checkout.

## Decision
- init tells a checkout from the package by its entry point: `main.ts` (any case) is a checkout, anything else, `main.js`, the package.
- From a checkout, everything ADR 0210 and [ADR 0212](0212-foedrum-init-takes-every-answer-as-an-option-and-foedrum-init-asks-them-in-a-session.md) say stays as it is.
- From the package, init asks no question about the shim, writes none, and `--no-input` refuses nothing for a missing `--shim` or `--repoint`.
- When `foedrum` runs a file on the PATH already (`resolveExecutable`), init says nothing about it.
  A `foedrum` in the `.bin` folder beside the package that runs does not count: `npm exec` puts that folder first on the PATH, and it goes with npx.
- Otherwise it says one line: `foedrum is not on the PATH: install it with npm install --global foedrum, or run npx foedrum <command>`.
- The check comes before every other shim check, so the package never says the PATHEXT line either.

## Consequences
- A user who ran `npx foedrum init` learns in one line how to run the next command, and nothing left in npx's cache sits on the PATH.
- A shim from a checkout left in npm's folder still meets a global install, as ADR 0210 says; init from the package does not touch it.
- No migration: Foedrum has no release yet, and a Brewery's files do not change.

## Alternatives considered
- **A shim that names the package's version (`npx foedrum@<version>`):** every call would go through npx, and it would still stand in the way of a global install.
- **Keep offering the shim from the package:** a shim into npx's cache breaks when npm clears it, with no error when it is written.
