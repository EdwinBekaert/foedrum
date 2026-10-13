# 0016. Delivery: an npm CLI and a companion Claude Code plugin

Date: 2026-10-13 · Status: Accepted

## Context
Foedrum uses Claude Code heavily, which raises the question of whether Foedrum itself should be a Claude Code plugin. A plugin lives inside an interactive Claude Code session. The engine, however, must poll GitHub, spawn and supervise `claude` processes, hold leases, enforce deadlines and survive crashes and reboots. It runs for days, for example while a batch is Conditioning until a release appears. That needs a process that does not depend on anyone's session.

## Decision
- **The core is a Node command-line program**, `foedrum`, published to npm. It contains the engine (`foedrum serve`, the Cellar), the setup and diagnostic commands (`init`, `doctor`, `status`, `stuck`, `replay`) and the default brewers, recipes and lenses.
- Installation: `npm install --global foedrum` or `npx foedrum`. Releases are published with npm provenance through trusted publishing (no long-lived tokens).
- **A companion Claude Code plugin** provides interactive commands such as `/foedrum:refine` ([ADR 0014](0014-interactive-refinement-plugin.md)). It contains Markdown commands and skills only and calls the `foedrum` CLI for everything that writes. The Foedrum repository is its plugin marketplace (`/plugin marketplace add EdwinBekaert/foedrum`). While the repository is private, adding the marketplace needs git credentials with access to it; from the public launch (M3) it works for everyone.
- **The Brewery** is created by `foedrum init` in the user's own repository.
- **The Brewhouse dashboard** (M6) is served by the engine itself; it is not a separate product.
- Running the engine as a background service is documented per operating system (systemd, launchd, Task Scheduler). Foedrum does not ship its own service manager.

## Consequences
- The engine works the same whether or not a Claude Code session is open. Users without the plugin lose only the interactive commands.
- The plugin and the CLI are versioned together. The plugin checks the CLI version it needs and says so when they differ.
- Users need Node ≥ 24.15. A single-file executable (Node single executable applications) can follow later for environments without Node; it would need building and signing for three platforms.

## Alternatives considered
- **Plugin only:** no installation step, but the engine would stop with the session, could not own other `claude` processes reliably and could not run unattended.
- **Single executable from the start:** no Node requirement, but adds a build and signing pipeline per platform before there are users who need it.
- **Container image as the main delivery:** uniform, but the user's Claude subscription login and local clones are awkward inside a container; containers stay an isolation option ([ADR 0010](0010-cross-platform-and-isolation-levels.md)).
