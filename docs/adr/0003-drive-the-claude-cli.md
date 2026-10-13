# 0003. Drive the user's `claude` CLI, not the Agent SDK

Date: 2026-10-13 · Status: Accepted

## Context
Brewers need Claude Code's tools, permission system and agent loop. The Claude Agent SDK offers a typed API (abort, budgets, structured output), but its terms ask third-party products to use API-key authentication. Foedrum users must be able to use their **Claude subscription**. The SDK is also proprietary, ships a large native binary, and releases almost daily.

## Decision
- Foedrum runs brewers by spawning the **user's installed `claude` CLI** in headless mode with `--output-format stream-json`.
- Foedrum never installs, bundles or authenticates Claude. Whatever the CLI is logged in with — subscription, API key, Bedrock, Vertex — is used.
- A brewer definition compiles to one CLI invocation plus a generated per-attempt settings file (see [brewers-and-recipes.md](../brewers-and-recipes.md#4-how-a-brewer-runs)).
- The engine **owns** the child process: it reads the stream live, renews the attempt's lease, and kills the whole process tree on deadline, stall or cancel.
- Runner access goes through an internal `BrewerRunner` interface, with a fake implementation for tests.

## Consequences
- Works with subscriptions; no Claude credentials ever pass through Foedrum.
- Zero npm dependencies for the agent layer.
- Foedrum must parse the stream format and track CLI changes; a contract test against the installed CLI version catches drift.
- On Windows the CLI can only be spawned through a shell, so every argument is validated against a strict pattern and prompts travel via stdin.
- Brewers remain external processes; deadlines, stall detection and leases are mandatory (see architecture §5).
- Open point: Anthropic's terms for subscription use by orchestration tools should be confirmed. The `BrewerRunner` interface keeps an API-key runner possible.

## Alternatives considered
- **Claude Agent SDK:** better typed API, but no subscription support for third-party tools, proprietary licence, large binary, high release churn.
- **Messages API directly:** full control and zero dependencies, but loses Claude Code's tools, permissions and agent loop — Foedrum would rebuild Claude Code.
