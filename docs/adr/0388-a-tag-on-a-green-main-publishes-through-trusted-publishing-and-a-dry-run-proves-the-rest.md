# 0388. A tag on a green `main` publishes through trusted publishing, and a dry run proves the rest

Date: 2026-11-12 · Status: Accepted · Amends [0377](0377-the-package-ships-the-javascript-tsc-emits-and-ci-starts-the-installed-tarball.md) (the package job becomes a workflow CI and the release both run, and `package.json` is no longer private) [0016](0016-delivery-npm-cli-and-companion-plugin.md) (how the package reaches npm) and [0113](0113-github-s-security-features-on-the-foedrum-repository.md) (the `npm` environment and its tag rule, and npm's publishing access, are settings of the maintainer's too)

## Context
[ADR 0377](0377-the-package-ships-the-javascript-tsc-emits-and-ci-starts-the-installed-tarball.md) made the packed tarball start once installed, and CI's `package` job proves it on three platforms.
#27 asks for the rest: a tag `v*` on `main`, only when the commit's CI is green, runs the package smoke test on Linux, Windows and macOS, publishes with provenance through trusted publishing (OIDC, no npm token) and creates a GitHub release with notes from the merged pull requests.
The maintainer decided on 2026-11-12 to build the workflow now and publish nothing; the first publish is #1022.

What npm's documentation and source say, read on 2026-11-12:
- Trusted publishing needs npm 11.5.1 and Node 22.14.0 or later, a cloud-hosted runner and `id-token: write`, and adds provenance by itself from a public repository; `--provenance` is not needed ([trusted publishers](https://docs.npmjs.com/trusted-publishers)).
- npm checks the trusted publisher against the calling workflow's file name when one workflow calls another that publishes.
- `package.json`'s `repository.url` must match the GitHub repository exactly; Foedrum's had no `repository` and was `private`.
- A trusted publisher is added only to a package that exists: "The package you're configuring must already exist on the npm registry" ([npm trust](https://docs.npmjs.com/cli/v11/commands/npm-trust)).
  Staging a name that does not exist publishes a placeholder `0.0.0-stage` ([staged publishing](https://docs.npmjs.com/staged-publishing)).
- Trusted publishers added after 2026-09-03 allow only `npm stage publish` until direct `npm publish` is allowed too.
- npm 11 refuses a prerelease version without `--tag` ("You must specify a tag using --tag when publishing a prerelease version", `lib/commands/publish.js`).

## Decision

### The workflow
`.github/workflows/release.yml` runs on a pushed tag `v*`, with no permissions at the workflow's level and five jobs:
- `guard` (`contents: read`, `actions: read`) fails unless the tag is `v` and `package.json`'s `version`, the commit is on `main` (`GET repos/<repo>/compare/<sha>...main` answers `ahead` or `identical`), and CI has a successful run of a push of that commit (`GET repos/<repo>/actions/workflows/ci.yml/runs?head_sha=<sha>&event=push&status=success`), both with the workflow's own `GITHUB_TOKEN` through `gh api`.
  Only a merge commit on `main` has such a run, so the tag goes on one.
  It also gives the dist-tag: `next` for a version with a prerelease part (a `-` after its core, before any `+` build metadata), else `latest`.
- `smoke` runs the package job.
  CI's run of the same commit passed it already; this run installs the tarball when it is published, on that day's runner images and newest Node 24, with the dependency the registry serves then, as a user's first install will.
- `publish` (`id-token: write`, `contents: read`) runs `npm ci`, `npm run build` and `npm publish --tag <dist-tag>` on `ubuntu-latest` in a fresh checkout, without the npm cache.
  It stays in `release.yml`, the file the trusted publisher names, and runs in the GitHub environment `npm`, whose deployment rule lets only `v*` tags in; the trusted publisher names that environment too, so npm takes no token from a run outside it.
  The environment has the maintainer as its required reviewer, so every publish waits for one approval on GitHub.
  Its condition, a pushed tag, keeps a mistake in the file from publishing; the environment is what keeps a branch that changes the file from publishing.
- `publish-dry-run` (`contents: read`) runs the same build and `npm publish --tag <dist-tag> --dry-run` for every other event, outside the environment and without `id-token`, and prints whether GitHub gave it an OIDC token request URL.
- `release` (`contents: write`) runs `gh release create <tag> --verify-tag --generate-notes`, with `--prerelease` for `next`.

Actions are pinned to the commit SHAs CI already uses; there is no new action and no new dependency.
The version changes in a pull request of its own; there is no bump tool.

### One package job
The `package` job moves, unchanged, into `.github/workflows/package.yml`, a reusable workflow (`workflow_call`) that CI's `package` job and the release's `smoke` job both call, so the release tests the package with the same steps as every pull request.
CI's check names become `package / package (<os>)`; `ci-ok`, the required check, still needs it.

### The package can be published
`package.json` drops `"private": true` and gains `repository` (`git+https://github.com/EdwinBekaert/foedrum.git`).

### The dry run
The same workflow, run by hand or by a pull request that changes `release.yml` or `package.yml`, is the dry run: the guards print what they find as warnings instead of failing, `publish-dry-run` runs instead of `publish`, and `release` is skipped.
GitHub dispatches only a workflow the default branch has, so the pull request trigger is what runs it before it merges.
It shows that the guards' API calls work with their permissions, that the package installs and starts on three platforms, and that npm accepts the package for publishing.
It does not show the OIDC exchange, the environment's rule, the trusted publisher entry, provenance or the release notes; #1022's first publish does.

### The first version
Since a trusted publisher needs a package on the registry, the environment is created first, and the first version is created once with the maintainer's own npm login, staged and approved with 2FA, without provenance; then the trusted publisher is added and token publishing is disallowed, and the next tag publishes through the workflow.
`docs/design/delivery.md` lists the steps for #1022.
Whether `foedrum init` from the installed package still offers the shim [ADR 0210](0210-foedrum-init-writes-the-foedrum-command-into-a-user-folder-on-the-path.md) describes, which [ADR 0377](0377-the-package-ships-the-javascript-tsc-emits-and-ci-starts-the-installed-tarball.md) left to this issue, is not decided here: #1030 owns it.

## Consequences
- Publishing needs a tag on a merge commit of `main` with a green CI run, and no npm token exists in the repository or its secrets.
- The first version on npm has no provenance badge; every version the workflow publishes has one.
- A branch that changes `release.yml` cannot publish: its runs are outside the environment's tag rule, and npm checks the environment.
  A `v*` tag on a commit outside `main` still runs that commit's `release.yml`, so whoever may push such a tag may publish: the maintainer, and every Claude Code session on the maintainer's machine, which pushes with the same credentials and whose local gate reads no tags.
  The required reviewer is what stops such a run: a session could approve the deployment only through a `gh api` write, which the session's permission prompts ask about.
- The environment and the trusted publisher are settings outside the repository's files; nothing in CI checks them.
- The Flight before tagging (M4) is a job of its own here when it comes.
- **Brewery migration:** none: Foedrum has no release yet.

## Alternatives considered
- **Copy the package job's steps into the release:** two copies to keep in step.
- **Publish from a reusable workflow:** npm would check the caller's name, and both would need `id-token: write`.
- **An npm token in a secret:** a long-lived credential the issue rules out.
- **Set the version from the tag in the workflow:** the published `package.json` would differ from the tagged commit's.
- **One publish job whose dry run passes `--dry-run`:** the dry run would need the environment's tag rule, which a pull request cannot meet, or the job would need `id-token` outside it.
- **Guard the publish by its event and ref in the file only:** a branch that changes the file removes the guard with it.
- **Publish the tarball the smoke test installed:** an artifact upload and download, two more actions, for a build `npm ci` and `tsc` repeat from the same commit.
