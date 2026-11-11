# Delivery

Foedrum ships as an npm command-line program with a companion Claude Code plugin ([ADR 0016](../adr/0016-delivery-npm-cli-and-companion-plugin.md)):

| Part | What it is | How users get it |
|---|---|---|
| `foedrum` CLI | The engine (`foedrum serve`), `init`, `doctor`, `status`, `stuck`, `replay`, and the default brewers, recipes and lenses | `npm install --global foedrum` or `npx foedrum`, published with provenance |
| Claude Code plugin | One skill, `/foedrum:<command>`, per command of the registry that is not terminal-only ([the plugin](humans/plugin.md)), in `plugin/`; Markdown only, each runs the CLI with `--via plugin` ([ADR 0125](../adr/0125-the-foedrum-plugin-is-markdown-skills-that-run-the-terminal-with-via-plugin.md)) | `claude plugin marketplace add EdwinBekaert/foedrum`, then `claude plugin install foedrum@foedrum --scope project`, in the Brewery's clone |
| Brewery | The user's control repository | `foedrum init` |
| Brewhouse (M6) | Dashboard served by the engine | `foedrum serve` prints its local address |

Until the package is on npm (M3), `foedrum init` offers a `foedrum` command in a user folder on the PATH that runs the checkout's `src/cli/main.ts` ([ADR 0210](../adr/0210-foedrum-init-writes-the-foedrum-command-into-a-user-folder-on-the-path.md)), and `/foedrum:init` runs that file from a checkout the engineer names until it is there ([ADR 0212](../adr/0212-foedrum-init-takes-every-answer-as-an-option-and-foedrum-init-asks-them-in-a-session.md)).

The package ships the JavaScript `tsc` emits from `src/` into `dist/` (`npm run build`, `tsconfig.build.json`), not the `.ts` files, since Node strips no types under `node_modules`; development runs the `.ts` files directly ([ADR 0377](../adr/0377-the-package-ships-the-javascript-tsc-emits-and-ci-starts-the-installed-tarball.md)).
Its `files` are `dist/`, `defaults/`, `schemas/` and the Job Object helper `src/platform/job-object.ps1`, which `tsc` does not copy; `bin` is `dist/cli/main.js`.
A module finds a file of the package from the package root, which lies as far above `dist/<area>/` as above `src/<area>/`: the defaults, `package.json` and the helper.
No lifecycle script builds it: CI runs `npm run build` before `npm pack`.
CI's `package` job builds, packs and installs the tarball into an empty folder outside the checkout on Linux, Windows and macOS for every pull request, then starts the installed `foedrum` (`--version`, `--help`, `doctor`), imports every emitted module and runs it once more through `npx` with the tarball as the package; `ci-ok` needs it.

The engine runs in a terminal or as a service the user sets up (documented for systemd, launchd and Task Scheduler); it never depends on an open Claude Code session.
