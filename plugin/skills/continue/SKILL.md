---
description: Continue a paused Foedrum order, or the whole Brewery
argument-hint: "<order> | --all"
disable-model-invocation: true
---

# /foedrum:continue

Lift a pause (ADR 0202): an order's, or with `--all` every pause, the intake's included. Arguments: `$ARGUMENTS`: an order (`<alias>#<n>`, or `#<n>` of the Brewery) or `--all`.

Run with the Bash tool, never PowerShell, in this folder (the Brewery's root), the order as one single-quoted argument, a `'` inside written `'\''`. Without a Bash tool in this session (Git Bash on Windows), say that the plugin needs it and stop.

1. Without an order or `--all` in the arguments, ask the engineer which to continue. Never choose for the engineer.
2. Run `foedrum continue '<order>' --via plugin`, or `foedrum continue --all --via plugin`.
3. Show its line as it is: what continues, or why it was refused.
