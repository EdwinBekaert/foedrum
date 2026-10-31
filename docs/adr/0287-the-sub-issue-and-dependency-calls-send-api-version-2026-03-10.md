# 0287. The sub-issue and dependency calls send API version 2026-03-10

Date: 2026-10-31 · Status: Accepted · Amends [0073](0073-github-only-through-gh-s-own-login.md) (a caller's `X-GitHub-Api-Version` wins over the client's)

## Context
ADR 0073 has every request send `X-GitHub-Api-Version: 2022-11-28`, and the client set it after the caller's headers, so no caller could ask for another.
#590 turns an approved plan into Brewery sub-issues with "blocked by" links, and #723 builds the calls for it.
Spike #18 tried them under `2026-03-10`, the version GitHub's REST docs list them with; only the list of sub-issues was also tried under `2022-11-28` ([trackers](../design/intake/trackers.md), its lines on identifiers and the version header).

## Decision
- **A caller's `X-GitHub-Api-Version` wins** over the client's default, and the request carries one such header (`src/github/client.ts`).
- **The sub-issue and dependency calls send `2026-03-10`**, reads included (`githubSubIssues`, `src/github/sub-issues.ts`): its own opening and finding of a Brewery issue, which answer the REST `id` the links name it by, and adding and listing sub-issues and "blocked by" links.
- **Every other request stays on `2022-11-28`**, as ADR 0073 has it, the claim marks' opening and finding of a claimed issue's Brewery order included ([ADR 0144](0144-a-claimed-target-issue-gets-a-brewery-issue-that-is-its-order.md), `githubIssueMarks`): they need no REST `id` and no labels, and were not tried under the newer version.

Rejected: moving every request to `2026-03-10` (the other calls were never tried under it, and a version changes what an answer holds); leaving the header out on these calls (GitHub then picks `2022-11-28`, which the writes were not tried under).

## Consequences
- Two API versions are in use at once; the sub-issue calls keep a conditional-read cache of their own, so an answer under one version never stands for the other.
- Once GitHub retires `2022-11-28`, the rest moves in an ADR of its own.
