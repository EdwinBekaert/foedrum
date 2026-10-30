# Platform support

Foedrum runs on **Windows, macOS and Linux** ([ADR 0010](../../adr/0010-cross-platform-and-isolation-levels.md)).
It supports **SHA-1 repositories**: a full commit id is 40 lowercase hex characters, checked by one function (`isCommitSha`, `src/schemas/store.ts`), and a 64-character SHA-256 id is refused with a line that names it as not supported, where ADR 0254 says it enters ([ADR 0254](../../adr/0254-foedrum-supports-sha-1-repositories.md)).

| Page | What it covers |
|---|---|
| [Isolation levels](isolation.md) | Sandboxed, permissions only, container; what doctor reports |
| [Cross-platform rules](cross-platform.md) | Rules for the code: CI, paths, spawning, killing, locks |
| [Keeping the machine awake](keep-awake.md) | The idle-sleep hold while `brew` or `serve` has an attempt running |
