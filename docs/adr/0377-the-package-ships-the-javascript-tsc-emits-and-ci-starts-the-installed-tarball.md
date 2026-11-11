# 0377. The package ships the JavaScript `tsc` emits, and CI starts the installed tarball on three platforms

Date: 2026-11-11 · Status: Accepted · Amends [0001](0001-typescript-on-node.md) (the build that emits the package's `.js`) [0016](0016-delivery-npm-cli-and-companion-plugin.md) (what the package holds, and `foedrum --version`), [0097](0097-npm-run-demo-is-a-script-on-serve-s-seams-with-the-tests-fakes.md) (the `files` the package ships) and [0210](0210-foedrum-init-writes-the-foedrum-command-into-a-user-folder-on-the-path.md) (the shim runs `main` beside the module that runs, `main.js` from the package)

## Context
`package.json`'s `bin` pointed at `src/cli/main.ts`, and the package shipped `src/`.
Installed from `npm pack`'s tarball into an empty folder (Windows, Node 24.20), `foedrum` did not start: `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`, since Node strips no types under `node_modules`.
[ADR 0001](0001-typescript-on-node.md) already said `tsc` would emit `.js` for the published package, but nothing did, and nothing would have noticed before the first publish.
`foedrum --version` was refused as an unknown option.
M3's exit test is `npx foedrum init` on Windows, macOS and Linux; publishing stays in #27.
This is #1000.

## Decision

### The build
- `npm run build` runs `tsc -p tsconfig.build.json`: `tsconfig.json` with emit on, `rootDir` `src` and `outDir` `dist`, over `src` only.
  `rewriteRelativeImportExtensions` turns every relative `.ts` import, dynamic ones too, into `.js`.
- No bundler and no new dependency: `tsc` is the one Foedrum already has.
- Development keeps running the `.ts` files directly; `dist/` is ignored by git and Biome.
- No lifecycle script builds it: npm runs no `prepack` under `ignore-scripts=true` (tried), and `package.json` has no `pre` or `post` scripts ([ADR 0004](0004-built-in-first-dependency-policy.md)).
  CI runs `npm run build` before `npm pack`; #27's publish will do the same.

### What the package holds
- `dist/` (the emitted JavaScript), `defaults/`, `schemas/` and `src/platform/job-object.ps1`; `bin` is `dist/cli/main.js`.
  Not the `.ts` sources: 283 files and 647.9 kB packed, against 532 files and 1.3 MB with both.
- With `rootDir` `src`, `dist/<area>/` lies as deep as `src/<area>/`, so a path a module builds from its own place up to the package root finds the same file from both.
  That holds for the defaults (`FOEDRUM_DEFAULTS`, unchanged), Foedrum's own `package.json` (for `--version`) and the Job Object helper (`helperFile`), now `../../src/platform/job-object.ps1`, since `tsc` copies no `.ps1` and a copy step would be a build script of its own.
- The entry point init's shim runs ([ADR 0210](0210-foedrum-init-writes-the-foedrum-command-into-a-user-folder-on-the-path.md)) is `main` beside the module that runs, with its extension (`mainBeside`): `main.ts` in a checkout, `main.js` in the package.
  Whether an installed package writes a shim at all is left to the publish (#27).
- `src/` has no other file read by a path relative to a module.

### `foedrum --version`
`foedrum --version` prints the `version` of Foedrum's own `package.json`, never the Brewery's in the working directory, and exits 0.
It is an option before any command, like `--help`, not a command of the registry; there is no `-v` and no `version` command.

### The package job
- A CI job, `package`, on `ubuntu-latest`, `windows-latest` and `macos-latest` for every pull request, push and nightly run: `npm ci`, `npm run build`, `npm pack` into `$RUNNER_TEMP`, and `npm install` of the tarball into an empty folder there, outside the checkout, so no module or dependency of the checkout stands in for one the package lacks; install scripts stay off there too.
- In that folder it runs the installed `foedrum --version` (equal to the package's version), `foedrum --help` and `foedrum doctor`, then imports every emitted module but the entry point, then `npx --package=<tarball> foedrum --version` from another empty folder, the form of M3's exit test.
- Doctor exits 1 on a runner without a gh login, and its findings depend on the runner, so the job holds only that it starts: exit 0 or 1, and nothing on stderr, where a crash prints its stack.
  On Windows doctor also starts node inside a Job Object, so the helper script is read from the package.
- `--help` and doctor load only some modules; the others (`serve`, `brew`, `resume`, init's) are imported when a command needs them, so the import step is what fails for a module the package lacks.
- `ci-ok` needs `package`.
- Not here: a clean container or a network-denied run (#27's comment, from another project).
  Each job already starts on a fresh runner, and nothing observed calls for either.
- Running `foedrum init` there was considered: with no gh login it stops at its first GitHub call, so it proves only that init's module loads, which the import step covers.

## Consequences
- The packed tarball, installed, starts `foedrum` on all three platforms, and a change that breaks that fails the pull request before the first publish.
- The `package` job adds a build, a pack and an install per leg, beside the `check` job.
- A new file a module reads at run time either lives under the package root at the same depth from `src/` and `dist/`, as these do, and is listed in `files`, or the package job fails on the platform that reads it.
- A file removed from `src/` stays in a local `dist/` until it is deleted: `tsc` removes nothing.
  CI builds in a fresh checkout, so the tarball it tests never holds one.
- **Brewery migration:** none: Foedrum has no release.

## Alternatives considered
- **A bundler (esbuild, rollup):** a new dependency with binaries and install scripts, which [ADR 0001](0001-typescript-on-node.md) and [ADR 0004](0004-built-in-first-dependency-policy.md) turn down.
- **Ship the `.ts` files beside the `.js`:** twice the size for files Node would never run.
- **A build script that also copies `job-object.ps1` into `dist/`:** a second step to keep in step with `tsc`, for one file a path from the package root already finds.
- **A `prepack` script:** npm runs none under `ignore-scripts`, and the house rule has none.
- **Assert doctor's text in CI:** its findings depend on the runner's tools and change with doctor itself; the job is about the package starting.
