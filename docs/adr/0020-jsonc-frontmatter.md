# 0020. Frontmatter is read as JSONC

Date: 2026-10-14 · Status: Accepted · Amends [0007](0007-jsonc-config-and-json-frontmatter.md)

## Context
[ADR 0007](0007-jsonc-config-and-json-frontmatter.md) makes configuration and recipes JSONC, and brewers and out docs Markdown with JSON frontmatter. It expects strict parsing, including for model-written frontmatter. The same frontmatter format now also carries house-yeast rules ([ADR 0018](0018-house-yeast-layers.md)).

While building the reader (#5), it turned out that people write brewers and rules by hand and want to comment fields, just as they do in recipes. Strict JSON for frontmatter would mean two readers and two sets of error messages for files that look the same to their authors. Rejecting a comment also does not make an out doc more correct: what an out doc may contain is already checked by its zod schema ([ADR 0005](0005-typed-step-outcomes-and-out-docs.md)).

## Decision
- All frontmatter (brewers, out docs, house-yeast rules) is read with the same JSONC reader as configuration: comments and trailing commas are allowed.
- Strictness comes from schema validation, not from the syntax: every frontmatter object is validated against its zod schema.
- Because frontmatter and configuration can come from target repositories, the reader rejects nesting deeper than 64 levels and input longer than 1 MiB (1,048,576 characters, not counting a BOM; for frontmatter the whole file, body included) with a `ParseError` that gives the position.
- The frontmatter is the JSON object between a `---` first line and the next line that is exactly `---`, even inside a comment.

## Consequences
- One reader, one error type (`ParseError` with line and column) for every Foedrum file format.
- Hand-written brewers and rules can carry comments.
- A model's out doc with a comment or a trailing comma is accepted; its content is still checked by the schema.
- Very large or very deeply nested files are rejected, even when they are valid JSON.

## Alternatives considered
- **Strict JSON frontmatter (ADR 0007 as written):** a second code path with its own error positions, and no comments in hand-written brewers.
- **JSONC for brewers and rules, strict JSON for out docs:** the reader would need to know who wrote a file; the schema already guards the content.
