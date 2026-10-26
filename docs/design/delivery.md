# Delivery

Foedrum ships as an npm command-line program with a companion Claude Code plugin ([ADR 0016](../adr/0016-delivery-npm-cli-and-companion-plugin.md)):

| Part | What it is | How users get it |
|---|---|---|
| `foedrum` CLI | The engine (`foedrum serve`), `init`, `doctor`, `status`, `stuck`, `replay`, and the default brewers, recipes and lenses | `npm install --global foedrum` or `npx foedrum`, published with provenance |
| Claude Code plugin | Interactive commands (`/foedrum:brew`, `status`, `stuck`, `brewers`, `lenses`, `answer`, `resume`, `init`; `refine` later), in `plugin/`; Markdown only, calls the CLI ([ADR 0125](../adr/0125-the-foedrum-plugin-is-markdown-skills-that-run-the-terminal-with-via-plugin.md)) | `claude plugin marketplace add EdwinBekaert/foedrum`, then `claude plugin install foedrum@foedrum --scope project`, in the Brewery's clone |
| Brewery | The user's control repository | `foedrum init` |
| Brewhouse (M6) | Dashboard served by the engine | `foedrum serve` prints its local address |

Until the package is on npm (M3), `foedrum init` offers a `foedrum` command in a user folder on the PATH that runs the checkout's `src/cli/main.ts` ([ADR 0210](../adr/0210-foedrum-init-writes-the-foedrum-command-into-a-user-folder-on-the-path.md)).

The engine runs in a terminal or as a service the user sets up (documented for systemd, launchd and Task Scheduler); it never depends on an open Claude Code session.
