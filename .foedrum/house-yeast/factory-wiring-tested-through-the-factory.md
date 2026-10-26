---
{
  "id": "factory-wiring-tested-through-the-factory",
  "scope": {
    "globs": [
      "test/**/*.test.ts",
      "src/cli/**/*.ts"
    ],
    "language": "typescript",
    "lens": "test-design"
  },
  "kind": "semantic",
  "source": "https://github.com/EdwinBekaert/foedrum/pull/440 finding 1 (test-design, round 1) and finding 4 (test-design, round 2), https://github.com/EdwinBekaert/foedrum/pull/555 finding 6",
  "created": "2026-10-26",
  "status": "active"
}
---
A dependency that a real-machine factory passes on (serveShell's runner, interactiveBrewerRunner's headless runner, the driver wiring's options) has a test through that factory, with a fake that answers before any real process starts, so dropping the dependency from the factory fails a test.
