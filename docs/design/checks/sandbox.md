# The check sandbox

A check's command line runs in an OS sandbox of Foedrum's own (`sandboxedChecks`, `src/platform/check-sandbox.ts`): `bwrap` on Linux and WSL2, `sandbox-exec` on macOS, with no network, the home folder hidden, and writes only in the worktree and a temporary folder; where that sandbox cannot start, the check is unstarted, never run without it.
On native Windows it runs as before, each reading says `unsandboxed`, and `foedrum serve` says so at start; a Brewery that requires the sandboxed level does not start there with a check step ([ADR 0076](../../adr/0076-check-steps-run-in-an-os-sandbox-with-no-network.md)).
