# Dependencies

Foedrum treats every dependency as attack surface. Built-in Node features come first; each package must pass the admission checklist below and is recorded here. Policy: [ADR 0004](docs/adr/0004-built-in-first-dependency-policy.md).

## Prerequisites (installed by the user, not by npm)

| Tool | Version | Why |
|---|---|---|
| Node.js | ≥ 24.15 | Runtime; `node:sqlite` and type stripping |
| npm | ≥ 11.19 (contributors) | Understands every `.npmrc` hardening key; enforced with `devEngines` (added in #1) |
| git | any recent | Worktrees, branches, diffs |
| `claude` CLI | logged in | Runs the brewers (subscription, API key, Bedrock or Vertex) |

## Admitted packages

Versions are pinned exactly when a package is first installed, after the 7-day minimum release age.

| Package | Kind | Purpose | Tree | Install scripts | Provenance | Licence |
|---|---|---|---|---|---|---|
| `zod` | runtime | Schemas: TypeScript types, runtime validation, generated JSON Schema | 0 deps | none | yes | MIT |
| `typescript` | dev | Type checking and emitting `.js` for publishing | wrapper + 1 platform binary | none | no — verified via registry signatures, diff review on bumps | Apache-2.0 |
| `@types/node` | dev | Types for Node's built-in APIs | 1 dep (`undici-types`) | none | partial | MIT |
| `@biomejs/biome` | dev | Lint and format | wrapper + 1 platform binary | none | yes | MIT OR Apache-2.0 |
| `undici-types` | dev (transitive, from `@types/node`) | Types for `fetch` and the other undici APIs in Node | 0 deps | none | yes | MIT |

## Built-ins used instead of packages

| Need | Built-in | Instead of |
|---|---|---|
| Event store | `node:sqlite` | better-sqlite3 |
| Tests | `node:test`, `node:assert` | vitest, jest |
| GitHub API | `fetch` | Octokit |
| GitHub App signing (later) | `node:crypto` | @octokit/auth-app |
| Running brewers | `node:child_process` | — |
| CLI arguments | `util.parseArgs` | commander, yargs |
| Configuration | `JSON.parse` + small JSONC reader | yaml, js-yaml |
| Running TypeScript | Node type stripping | tsx, esbuild |
| Dashboard (later) | `node:http` + Server-Sent Events | web frameworks |

## Admission checklist

A package is admitted only if every point is answered in the pull request that adds it, and its row is added above:

1. **Need** — what it does, why the built-in is not enough, how many lines it would take to write ourselves.
2. **Kind** — runtime or dev; which entry points are imported.
3. **Tree** — direct and transitive count on one platform (`npm ls --all` attached).
4. **No install scripts** anywhere in the tree. Native code only as prebuilt optional platform packages.
5. **Provenance** — attestations present, or a written reason why their absence is acceptable plus a diff review on every bump.
6. **Maintenance** — released within the last 12 months; more than one maintainer or organisational backing, or a documented exception.
7. **Licence** — OSI-approved and compatible with AGPL-3.0.
8. **Security history** — OSV/GHSA checked; latest version free of open advisories.
9. **Exit plan** — wrapped behind an internal module; how hard it would be to remove.
10. **Review** — a maintainer approves the pull request.

## Install hardening

See [.npmrc](.npmrc): no lifecycle scripts, minimum release age of 7 days, exact versions, registry tarballs only, peers not auto-installed, strict engines.

Because lifecycle scripts are disabled, Foedrum's own `package.json` uses no `pre*`/`post*` scripts.

### Verified behaviour

Checked in a throwaway project with this `.npmrc` (spike [#16](https://github.com/EdwinBekaert/foedrum/issues/16); npm 11.19.0, Node 24.20.0, Windows 11; 2026-10-13):

| Setting | Result |
|---|---|
| `min-release-age=7` | `zod@4.6.7` (1 day old) and `zod@^4.6.6` fail with `ETARGET … with a date before …`. `zod` and `zod@latest` resolve to 4.6.5, the newest version older than 7 days. |
| `min-release-age-exclude` | `--min-release-age-exclude=zod` (or `min-release-age-exclude[]=zod` in `.npmrc`) lets `zod@4.6.7` install. Only the named package is exempt, not its dependencies. Use it per command for an urgent security fix; never commit it. |
| **Lockfile bypass** | `min-release-age` only filters *resolution*. A lockfile that already pins a young version installs it with both `npm ci` and `npm install`. The CI lockfile checker must therefore check publish dates itself. |
| `ignore-scripts=true` | A dependency's `preinstall`/`install`/`postinstall` and the root's `preinstall`/`postinstall`/`prepare` do not run on `npm install` or `npm ci`. `npm test` runs `test` but skips `pretest`/`posttest`. Control run with `--ignore-scripts=false` fired all of them. |
| `allow-git=none` | `github:…` and `git+https://…` fail with `EALLOWGIT`, also when the git dependency comes in transitively. |
| `allow-remote=none` | Tarball URLs fail with `EALLOWREMOTE`, also transitively. |
| `engine-strict=true` | The root project's own `engines` is enforced (`EBADENGINE`) on `npm install` and `npm ci`. |
| Unknown keys | An npm that does not know a key only warns (`Unknown cli config`) and ignores it, so an old npm silently drops the hardening. `devEngines.packageManager` with `onFail: "error"` fails with `EBADDEVENGINES` instead, and does not affect users installing the published package. |

Local tarballs and directories are still allowed (`allow-file` and `allow-directory` default to `all`). They need a deliberate local path, so they are left at the default.

## Continuous integration (planned)

- `npm ci` only, with a committed lockfile.
- `npm audit signatures` and `npm audit --omit=dev`.
- GitHub Actions pinned to commit SHAs.
- Releases published with npm trusted publishing and provenance.

## Dependency guard

[`scripts/check-deps.ts`](scripts/check-deps.ts) checks `package-lock.json` and fails when:

- an entry has a malformed package name or version, its `resolved` URL is not the registry tarball of its own name and version (`https://registry.npmjs.org/<name>/-/<name>-<version>.tgz`), or it is a link;
- an entry has no `sha512-` integrity;
- any package in the tree has an install script;
- the package budget is exceeded (runtime ≤ 2, total ≤ 10). It counts the installed tree, as [ADR 0004](docs/adr/0004-built-in-first-dependency-policy.md) intends ("about 7 packages in `node_modules`"): every package name in the lockfile once, transitive ones included, except platform binaries (entries marked `optional` with an `os` or `cpu` restriction, of which npm installs only the one for the machine). Runtime counts the packages not marked `dev` or `devOptional`;
- a package in that same set has no row under [Admitted packages](#admitted-packages);
- a locked version was published less than `min-release-age` days ago (read from `.npmrc`), because a version already in the lockfile skips that check in npm (spike #16). This needs the registry.

The budget above and the admitted-packages table are read by the checker; keep their format.

- `npm run check` runs it with `--offline` (no publish dates), so it stays fast and works without a network.
- `npm run check:deps` runs every rule, including publish dates. The CI workflow (#2) will run it on every pull request; until then, run it yourself after changing the lockfile.
- [Dependabot](.github/dependabot.yml) proposes npm and GitHub Actions updates weekly, grouped, with a 7-day cooldown.
