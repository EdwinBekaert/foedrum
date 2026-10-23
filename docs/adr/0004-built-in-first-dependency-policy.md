# 0004. Built-in first dependency policy

Date: 2026-10-13 · Status: Accepted · Amended by [0113](0113-github-s-security-features-on-the-foedrum-repository.md) and [0119](0119-npm-audit-runs-once-per-ci-run-with-one-retry-on-an-outage.md)

## Context
Compromised npm packages are a recurring, real threat (hijacked maintainers, malicious install scripts, self-propagating worms). One 2025 attack specifically drove locally installed AI coding CLIs to hunt for secrets — exactly the kind of machine Foedrum runs on. Typical stacks for a tool like this pull in 400+ packages.

## Decision
- **Use Node built-ins first:** `node:sqlite`, `node:test`, `fetch`, `node:crypto`, `node:child_process`, `util.parseArgs`, `node:http`, type stripping.
- **Runtime dependencies: `zod` only.** One definition yields TypeScript types, runtime validation and the JSON Schema files used for editor autocompletion.
- **Development dependencies:** `typescript`, `@types/node`, `@biomejs/biome`.
- Every dependency must pass the admission checklist in [DEPENDENCIES.md](../../DEPENDENCIES.md) and be wrapped behind an internal module.
- Install hardening via a committed `.npmrc`: no lifecycle scripts, a minimum release age of 7 days, exact versions, registry tarballs only, peers not auto-installed, strict engines.
- CI: `npm ci` only, `npm audit signatures`, a lockfile checker (registry-only URLs, integrity present, no install scripts, package budget), Dependabot with a 7-day cooldown, all actions pinned to commit SHAs.
- Foedrum itself is published with npm trusted publishing and provenance.

## Consequences
- About 7 packages in `node_modules` in development, 1 for users.
- Some code we write ourselves (a small GitHub client, a JSONC parser); it is small, tested and free of supply-chain risk.
- `node:test` coverage and module mocking are still experimental: we design for dependency injection instead.

## Alternatives considered
- **Octokit:** 11–52 packages for a dozen endpoints we can call with `fetch`.
- **vitest / jest:** 35–330 packages, native bindings or install scripts.
- **eslint + prettier + typescript-eslint:** about 100 packages, incompatible with TypeScript 7.
- **Zero runtime dependencies** (hand-written validators): possible, but types, validation and JSON Schemas would drift apart.
