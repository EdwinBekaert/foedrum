---
description: Print the terminal line that opens a finished Foedrum brewer attempt's Claude Code session
argument-hint: "<batch> [<step>[#<n>]]"
disable-model-invocation: true
---

# /foedrum:resume

A session cannot hand its terminal to another `claude`, so inside one `foedrum resume` opens nothing: it names the attempt and prints the line to run in a terminal (ADR 0126, ADR 0125). Arguments: `$ARGUMENTS` — a batch, and optionally a step with an attempt number.

Run `foedrum resume <batch> [<step>[#<n>]] --via plugin` with the Bash tool in this folder (the Brewery's root). Show the engineer the line it printed, to run in a terminal in this folder, or foedrum's line when it refused. Never run that line from this session.
