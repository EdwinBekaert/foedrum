# Dependencies

Foedrum treats every dependency as attack surface. Built-in Node features come first; each package must pass the admission checklist below and is recorded here. Policy: [ADR 0004](docs/adr/0004-built-in-first-dependency-policy.md).

## Prerequisites (installed by the user, not by npm)

| Tool | Version | Why |
|---|---|---|
| Node.js | ≥ 24.15 | Runtime; `node:sqlite` and type stripping |
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

## Continuous integration (planned)

- `npm ci` only, with a committed lockfile.
- `npm audit signatures` and `npm audit --omit=dev`.
- A lockfile checker: registry URLs only, integrity present, no install scripts, package budget (runtime ≤ 2, total ≤ 10), every package listed in this file.
- Dependabot with a 7-day cooldown; GitHub Actions pinned to commit SHAs.
- Releases published with npm trusted publishing and provenance.
