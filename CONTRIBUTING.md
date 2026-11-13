# Contributing to Foedrum

Thank you for wanting to help.
This guide is the short version: what to do, in the order you meet it.
The full rules for working on Foedrum's code are in [`CLAUDE.md`](CLAUDE.md), and each section below links the part that holds the detail.

Foedrum is not open to outside pull requests yet: they will be closed until the public launch (milestone M3).
Issues with questions, ideas or feedback are welcome now.

## Before you start

Comment on the issue you want to work on, and wait until it is assigned to you before you start.
Then nobody does the same work twice, and you know the issue is still wanted.

- An issue labelled `discuss first` waits for the maintainer: talk the details through on the issue before any implementation.
- An issue labelled `good first issue` is the place to start.
- For something with no issue yet, open one first and say what you would change and why.

## Set up

You need Node 24.15 or later (`package.json`'s `engines`) and git.

```sh
git clone https://github.com/EdwinBekaert/foedrum.git
cd foedrum
npm ci
```

Install with `npm ci`: it installs exactly what `package-lock.json` holds, with install scripts off (`.npmrc`).
Run TypeScript directly with `node`; there is no build step for development.

While you work, run the test file you change on its own:

```sh
node --test test/unit/<file>.test.ts
```

Before you push, run:

```sh
npm run check
```

It runs the typecheck, the lint, the tests your change reaches, and the repository's guards, in one command.
Format with `npm run lint -- --write`.
The whole test run is CI's: it runs every test on Windows, macOS and Linux for every pull request.
More in [`CLAUDE.md`, Commands](CLAUDE.md#commands).

## What a change looks like

**Test first.**
Commit the failing test before the fix or the feature, in a commit of its own, so the red step can be checked out and run.
Then commit the code that makes it pass.
Red means the test runs and fails because the behaviour is missing; a test that does not load or compile is not red.
Documentation, CI configuration, scaffolding and throwaway spikes are exempt: say so in the pull request.
The rules for red, green, refactor and regression tests are in [`CLAUDE.md`, Tests](CLAUDE.md#tests).

**One issue per pull request.**
A pull request closes the one issue it delivers, with `Closes #<n>` in its description.
When the work is too big for one pull request, split the issue first.

**Open it as a draft.**
Mark it ready when the work is done; the next section says how it is reviewed.

**Update it by merging `main`, never by rebasing.**
Pushed commits are never rewritten or force-pushed, and pull requests are merged with a merge commit, so the red and green commits stay in the history.

**An ADR for a design decision.**
A change to the design gets a new record in [`docs/adr/`](docs/adr/) in the same pull request, and the design page it changes under [`docs/design/`](docs/design/) is kept in step.
Read the existing ADR before changing what it decided: a change of mind is a new ADR.

Commit messages have an imperative subject line and, when it helps, a short body that says why.
Branches, descriptions and the rest are in [`CLAUDE.md`, Git and pull requests](CLAUDE.md#git-and-pull-requests).

## Review

A pull request is reviewed with the `/brew-review` skill in [`.claude/skills/brew-review/`](.claude/skills/brew-review/) while it is a draft, unless it changes only plain documentation ([ADR 0067](docs/adr/0067-a-pull-request-of-only-plain-docs-needs-no-review-summary.md)).
It runs the red proof, a simplify pass, a reviewer per lens and a mutation check, and posts a summary comment with a disposition for every finding.

You are advised to run it on your own pull request before you mark it ready, so its findings are settled before review instead of passed back and forth.
The maintainer always runs it before approving.

The skill needs a coding agent that runs skills and can start the read-only reviewer subagents defined in [`.claude/agents/`](.claude/agents/).
When it cannot start them, it stops before its red proof and says to start a new session, since an agent loads those definitions when its session starts.

## Signing the CLA

Contributions require the [Contributor License Agreement](CLA.md), a licence grant: you keep your copyright.
To sign it, add this line to [`.github/cla-signatures.md`](.github/cla-signatures.md) in a commit of its own in your first pull request:

```
- @<your GitHub login>, CLA 1.0, <YYYY-MM-DD>
```

A CI check reads that file on every pull request, and fails until the pull request's author has signed.

## Security and the name

Report a security problem privately, as [`SECURITY.md`](SECURITY.md) says, never in a public issue.

The Foedrum name, logo and mascot are not covered by the code licence.
