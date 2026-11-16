---
{
  "id": "docs-of-a-variable-list-follow-the-code-that-builds-it",
  "scope": {
    "globs": [
      "docs/**/*.md",
      "src/engine/brewer-env.ts",
      "src/schemas/brewer.ts"
    ]
  },
  "kind": "semantic",
  "source": "https://github.com/EdwinBekaert/foedrum/pull/475 finding 1 (design-conformance) and finding 1 (design-conformance re-check), https://github.com/EdwinBekaert/foedrum/pull/1122 finding 1 (design-conformance)",
  "created": "2026-11-16",
  "status": "active"
}
---
A doc sentence about which environment variables a process gets, or which names a brewer's env may not set, is checked against the code that builds that list (brewerBaseEnv, terminalEnv, brewerForcedEnv, reservedEnv) when the list changes, so no sentence claims a name is rejected or reaches the process when the code says otherwise.
