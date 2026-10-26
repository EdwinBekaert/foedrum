---
description: Pause a Foedrum order, or the whole Brewery, at its next convenient point
argument-hint: "<order> | --all [--by <time>] [--why <reason>]"
disable-model-invocation: true
---

# /foedrum:pause

Pause an order, or with `--all` the whole Brewery and its intake (ADR 0202): nothing new starts, and what runs ends at its next convenient point. Arguments: `$ARGUMENTS`: an order (`<alias>#<n>`, or `#<n>` of the Brewery) or `--all`, then optionally `--by` and `--why`.

Every command below runs with the Bash tool, never PowerShell, in this folder (the Brewery's root). Pass each value as one single-quoted argument, a `'` inside written `'\''`. Without a Bash tool in this session (Git Bash on Windows), say that the plugin needs it and stop.

1. Without an order or `--all` in the arguments, ask the engineer which order to pause, or whether to pause everything. Never choose for the engineer.
2. Run `foedrum pause '<order>' --via plugin`, or `foedrum pause --all --via plugin`, adding `--by '<time>'` (a local time such as `17:30`, or a duration such as `20m`: what still runs then is stopped) and `--why '<reason>'` only when the engineer gave them.
3. Show its line as it is: what the pause holds, or why it was refused. `/foedrum:continue` lifts it.
