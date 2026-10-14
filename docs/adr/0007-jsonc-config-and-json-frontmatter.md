# 0007. JSONC configuration, JSON frontmatter

Date: 2026-10-13 · Status: Accepted, amended by [0020](0020-jsonc-frontmatter.md) (frontmatter is read as JSONC; input limits)

## Context
Foedrum reads configuration, recipes, brewer definitions and out docs written by models. YAML is familiar from GitHub Actions but needs a third-party parser and has well-known pitfalls (indentation, implicit types). Prompts — the main reason to want multi-line strings — live in Markdown bodies, not in configuration.

## Decision
- **Configuration and recipes** are **JSONC** (JSON with comments and trailing commas): `foedrum.jsonc`, `models.jsonc`, `recipes/*.jsonc`.
- **Brewers and out docs** are Markdown with **JSON frontmatter** between `---` lines.
- A small in-house JSONC reader strips comments and trailing commas (string-aware, fully tested), then uses `JSON.parse`.
- JSON Schema files are generated from the zod schemas and referenced through `"$schema"`, giving autocompletion and validation in editors.

## Consequences
- No YAML dependency; parsing is strict and predictable, including for model-written frontmatter.
- Editors help users write recipes.
- The visual recipe editor (later) reads and writes JSON trivially.
- Slightly more verbose than YAML.

## Alternatives considered
- **YAML:** familiar, but a dependency, looser parsing, and pitfalls with model-written content.
- **TOML:** good multi-line strings, but nested step lists read poorly.
- **Plain JSON:** no comments, which recipes benefit from.
