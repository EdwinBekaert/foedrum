# Security

## Reporting a vulnerability

Please don't open a public issue for a security problem. Report it privately through GitHub instead: on the repository's **Security** tab, choose **Report a vulnerability**. Only the maintainer sees the report, and the fix and its advisory are worked out there before anything is public.

Say what you found, how to reproduce it, and what an attacker gains. A proof of concept against your own machine or a test repository is welcome; never against someone else's.

## What counts

Foedrum runs model output and the commands its recipes name on your machine, so the boundaries it promises are what matter most:

- a brewer that gets past its allowlist, its worktree, its git's missing push credential or the sandbox it was given;
- text from an issue, an out doc or a target repository that Foedrum follows as an instruction, or that reaches a pull request, a comment or a log it should stay out of (a secret, for one);
- a cleanup or a check that runs a command a brewer planted, or deletes outside Foedrum's own folders;
- the local gate (`scripts/precheck.ts`) letting a merge, a force push or a push of unchecked code through;
- a dependency or workflow that runs code it shouldn't.

Problems in Claude Code itself go to Anthropic, in git or gh to their projects, and in a package Foedrum uses to that package; tell us too if Foedrum is exposed by them.

## Versions

Foedrum has no release yet. Only `main` is supported, and fixes land there.

## What GitHub checks on this repository

Secret scanning with push protection, Dependabot alerts and security updates, and private vulnerability reporting are on ([ADR 0113](docs/adr/0113-github-s-security-features-on-the-foedrum-repository.md)). Dependabot's weekly version updates and CI's `npm audit` follow [ADR 0004](docs/adr/0004-built-in-first-dependency-policy.md).
