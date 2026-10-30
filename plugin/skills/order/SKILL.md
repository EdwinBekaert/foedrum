---
description: Order an issue with Foedrum, its first batch or an ended one's next
argument-hint: "<issue>"
disable-model-invocation: true
---

# /foedrum:order

Order an issue (ADR 0105, ADR 0240): its first batch, or a new one once its last is on tap or cancelled. A target issue (`<alias>#<n>`) is claimed first, so no other Brewery orders it; a claimed order's Brewery issue (`#<n>`) orders the issue it was claimed for. Arguments: `$ARGUMENTS`: one issue (`<n>`, `#<n>` or `<alias>#<n>`).

Run with the Bash tool, never PowerShell, in this folder (the Brewery's root), the issue as one single-quoted argument (a bare `#21` would start a comment), a `'` inside written `'\''`. Without a Bash tool in this session (Git Bash on Windows), say that the plugin needs it and stop.

1. Without an issue in the arguments, ask the engineer which issue to order. Never choose for the engineer, and order only the issue named.
2. Run `foedrum order '<issue>' --via plugin`.
3. Show its line as it is: the new batch and its lane, or why it was refused. The batch waits for its recipe: `/foedrum:brew` routes it by the issue's `recipe:<name>` label, and `/foedrum:recipe` chooses one.
