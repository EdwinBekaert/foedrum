---
description: Move a Foedrum order in the intake's queue, or mark it to finish first
argument-hint: "<order> [<n> | first] [--why <reason>]"
disable-model-invocation: true
---

# /foedrum:rank

Move an order in the intake's queue, which orders and claims by arrival unless a person moved one (ADR 0208): to place `<n>`, or `first` to finish it before every order without the mark. With no place, show where the order stands. Arguments: `$ARGUMENTS`: an order (`<alias>#<n>`, or `#<n>` of the Brewery), then optionally a place and `--why`.

Every command below runs with the Bash tool, never PowerShell, in this folder (the Brewery's root). Pass each value as one single-quoted argument, a `'` inside written `'\''`. Without a Bash tool in this session (Git Bash on Windows), say that the plugin needs it and stop.

1. Without an order in the arguments, ask the engineer which order to rank. Never choose for the engineer.
2. Run `foedrum rank '<order>' --via plugin` to show its place, or `foedrum rank '<order>' '<n>' --via plugin` or `foedrum rank '<order>' first --via plugin` to move it, adding `--why '<reason>'` only when the engineer gave one.
3. Show its line as it is: the order's place in the queue and its rank, or why it was refused.
