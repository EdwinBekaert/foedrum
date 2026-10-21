# 0113. GitHub's security features on the Foedrum repository

Date: 2026-10-21 · Status: Accepted · Amends [0004](0004-built-in-first-dependency-policy.md) (which of GitHub's own checks run next to the dependency policy)

## Context
The repository is public. [ADR 0004](0004-built-in-first-dependency-policy.md) set the dependency policy: built-ins first, an admission checklist, `npm audit` and `npm audit signatures` in CI, and Dependabot version updates, weekly and grouped, with a 7-day cooldown. GitHub's other security features were off: secret scanning, push protection, Dependabot alerts and security updates, and private vulnerability reporting. Foedrum runs model output and commands on its users' machines, so people will look for holes in it, and a credential pushed to a public repository is copied within minutes.

## Decision
- **On:** secret scanning with push protection; Dependabot alerts and Dependabot security updates; private vulnerability reporting, with `SECURITY.md` saying how to report and what counts.
- **Kept as ADR 0004 has them:** Dependabot version updates (weekly, grouped, 7-day cooldown) and `npm audit` in CI. A Dependabot security update is a pull request like any other: it passes DEPENDENCIES.md's checklist and the review before it merges.
- **Later:** code scanning (CodeQL), a workflow of its own, when the repository is prepared for the public launch (M3), as an issue with a review.

## Consequences
- A push that carries a recognised credential is refused by GitHub, also a session's push; the remedy is to remove the credential from the commits, never to bypass the block.
- Reports of a vulnerability arrive privately, as a draft advisory.
- These are repository settings, not files: changing them is the maintainer's, and this record is where a change is written down.

## Alternatives considered
- **Turn version updates off and keep only security updates:** fewer pull requests, but ADR 0004 chose regular, cooled-down updates over large jumps, and `npm run check:deps` enforces the cooldown.
- **Leave everything to Foedrum's own secret scan ([ADR 0079](0079-the-push-scans-the-batch-s-commits-for-secrets.md)):** that scan covers a batch's commits in a target repository, not pushes to Foedrum itself.
