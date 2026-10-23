---
description: Print the terminal line that opens a Foedrum brewer attempt's Claude Code session, or takes a running batch over to continue it
argument-hint: "<batch> [<step>[#<n>]]"
disable-model-invocation: true
---

# /foedrum:resume

A session cannot hand its terminal to another `claude`, so inside one, foedrum's resume opens nothing: it names the attempt and prints the line to run in a terminal (ADR 0126, ADR 0125). On a running batch, that line takes the batch over and continues its step's session there; the batch goes on once the session wrote its out doc (ADR 0127). Arguments: `$ARGUMENTS`: a batch, and optionally a step with an attempt number.

Run `foedrum resume '<batch>' ['<step>[#<n>]'] --via plugin` with the Bash tool, never PowerShell, in this folder (the Brewery's root), each value single-quoted (a `#` would otherwise start a comment). Show the engineer the line it printed, to run in a terminal in this folder, or foedrum's line when it refused. Never run that line from this session. Without a Bash tool in this session (Git Bash on Windows), say that the plugin needs it and stop.
