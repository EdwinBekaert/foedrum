# The plugin

The Claude Code plugin lives in `plugin/`: Markdown skills only, one per `/foedrum:<command>`, with this repository as its marketplace ([ADR 0125](../../adr/0125-the-foedrum-plugin-is-markdown-skills-that-run-the-terminal-with-via-plugin.md)).
How users get it: [delivery](../delivery.md).
The plugin's skills run the terminal with `--via plugin`, which every command of the registry takes (`plugin` or `terminal`): it changes the surface its events record, never what a command may do.
The plugin carries `brew`, `status`, `stuck`, `brewers`, `answer` and `resume` ([ADR 0159](../../adr/0159-foedrum-brewers-reports-each-brewer-s-attempts-outcomes-stuck-batches-and-tokens.md) for `brewers`); every other command is marked `terminalOnly` with its reason in the registry, and a parity test (`test/unit/plugin-parity.test.ts`) fails on a command with neither a skill nor a mark (ADR 0125).
How `/foedrum:brew` drives a batch: [foedrum brew and the plugin](brew.md).
