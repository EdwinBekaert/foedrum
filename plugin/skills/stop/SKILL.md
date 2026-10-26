---
description: Stop a Foedrum order now, its batches Stuck until retry
argument-hint: "<order> [--why <reason>]"
disable-model-invocation: true
---

# /foedrum:stop

Stop an order now (ADR 0205): what runs of it is killed, and each of its brewing batches is Stuck with reason `stopped` until a retry (`/foedrum:stuck` lists it) continues it from the same step. Arguments: `$ARGUMENTS`: an order (`<alias>#<n>`, or `#<n>` of the Brewery), then optionally `--why`.

Run with the Bash tool, never PowerShell, in this folder (the Brewery's root), each value as one single-quoted argument, a `'` inside written `'\''`. Without a Bash tool in this session (Git Bash on Windows), say that the plugin needs it and stop.

1. Without an order in the arguments, ask the engineer which order to stop. Never choose for the engineer, and never stop more than the order named: there is no `--all` (`/foedrum:pause --all --by` stops everything that runs).
2. Run `foedrum stop '<order>' --via plugin`, adding `--why '<reason>'` only when the engineer gave one.
3. Show its line as it is: which batches are Stuck and at which step, or why it was refused. What the attempt had not committed is lost.
