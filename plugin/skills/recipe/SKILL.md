---
description: Choose or change the recipe an issue or a batch brews with, from its first step
argument-hint: "<issue | batch> <recipe> <reason>"
disable-model-invocation: true
---

# /foedrum:recipe

Choose or change the recipe of an issue, or of one batch (ADR 0240). By issue (`<n>`, `#<n>` or `<alias>#<n>`), it acts on the issue's latest batch: an ended one, or none yet, is ordered again with the recipe; an Ordered, Conditioning or Stuck one restarts from the recipe's first step, on its commits so far; a Brewing one is refused until `/foedrum:stop` stops it. The issue gets the `recipe:<name>` label once a driver runs the batch, its other recipe labels taken off. Arguments: `$ARGUMENTS`: the issue or batch, the recipe, then the reason.

Run with the Bash tool, never PowerShell, in this folder (the Brewery's root), each value as one single-quoted argument (a bare `#21` would start a comment), a `'` inside written `'\''`. Without a Bash tool in this session (Git Bash on Windows), say that the plugin needs it and stop.

1. Without an issue or batch, a recipe or a reason in the arguments, ask the engineer for what is missing. Never choose the recipe or write the reason for the engineer.
2. Run `foedrum recipe --via plugin -- '<issue or batch>' '<recipe>' '<reason>'`: after `--` every argument is a positional one, also a reason that starts with `-`.
3. Show its lines as they are: the batch it ordered, if any, and where the batch is now, or why it was refused. Then `/foedrum:brew` with the same issue brews it.
