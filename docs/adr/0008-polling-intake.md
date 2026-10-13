# 0008. Polling intake

Date: 2026-10-13 · Status: Accepted

## Context
Foedrum runs on a developer's machine, usually behind NAT, without a public endpoint. Webhooks require a reachable server or a relay service.

## Decision
- Intake **polls** the Brewery for new or changed issues and comments, using conditional requests (ETags) to stay well within rate limits.
- Intake sits behind the `Tracker` interface (architecture §3.1); a webhook adapter, or a tracker other than GitHub, can be added later without changing the engine.
- GitHub access uses `fetch` with a small in-house client. Authentication in 1.0 is a fine-grained personal access token; a GitHub App comes later.

## Consequences
- Zero infrastructure: `foedrum serve` on a laptop is enough.
- Reaction time of seconds to a minute, which is negligible next to agent run times.
- Polling cost grows with the number of watched repositories; conditional requests keep it small.

## Alternatives considered
- **Webhooks:** instant, but need a public endpoint or a relay.
- **GitHub Actions as the runtime:** no local machine needed, but long agent runs, Claude login and local worktrees fit poorly.
