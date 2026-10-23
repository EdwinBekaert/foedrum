---
{
  "id": "guard-on-two-paths-tested-on-each",
  "scope": {
    "globs": [
      "src/**/*.ts",
      "scripts/**/*.ts"
    ],
    "language": "typescript",
    "lens": "test-design"
  },
  "kind": "semantic",
  "source": "https://github.com/EdwinBekaert/foedrum/pull/378 finding 1 (test-design, round 2), https://github.com/EdwinBekaert/foedrum/pull/424 finding (test-design, round 2, 2)",
  "created": "2026-10-23",
  "status": "active"
}
---
When the same guard or early return is written on two code paths (a check step and a red proof), each path has a test that reaches it, so deleting either copy fails a test.
