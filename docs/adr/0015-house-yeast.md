# 0015. House yeast: scoped, budgeted, promotable rules

Date: 2026-10-13 · Status: Accepted

## Context
Learning from reviews is valuable: the same mistake should not be made twice. The naive implementation — append every lesson to one rules file and have every agent read it before coding — grows without bound. Such files easily reach hundreds of rules and tens of thousands of tokens per run; capping them drops the newest lessons, and models follow a long undifferentiated list less reliably than a short relevant one.

## Decision
- **House yeast** is the Brewery's collection of learned rules, stored as files in `house-yeast/`.
- Each rule has **metadata**: scope (repository, file globs, language), kind (structural / semantic), source review, date, and counters for selection and violations.
- Rules are **selected per attempt**: only rules whose scope matches the repository and files of the attempt, ordered by relevance and recency, within a **token budget** (default ~2,000 tokens).
- Rules that can be checked mechanically are **promoted to gravity readings** (lint rules, search patterns, tests) and removed from prompts.
- A periodic **curation** step merges duplicates, consolidates similar rules and retires rules that have gone unused; its changes are proposed as pull requests.
- **Suppressions** ("do not flag this again") are rules for the reviewing brewer, with the same scoping.
- Delivery: metadata, scoped selection, budget and suppressions in M2; promotion and curation in M4, where evaluations can measure their effect.

## Consequences
- Rule cost per attempt is bounded regardless of how much the Brewery has learned.
- Brewers see the rules that matter for the code in front of them.
- The most valuable rules become deterministic checks: cheaper and stricter than prompts.
- Rules need scope metadata; rules without a scope fall back to repository-wide and are flagged for curation.

## Alternatives considered
- **One file read in full:** simple, but unbounded token cost and diluted adherence.
- **A fixed size cap:** bounds cost, but silently drops rules — often the newest.
- **Embedding-based retrieval:** flexible, but adds a dependency and opaque selection; scope metadata is transparent and sufficient.
