---
{
  "id": "key-part-tested-with-a-second-value",
  "scope": {
    "globs": [
      "src/**/*.ts"
    ],
    "lens": "test-design"
  },
  "kind": "semantic",
  "source": "https://github.com/EdwinBekaert/foedrum/pull/667 finding test-design 2, https://github.com/EdwinBekaert/foedrum/pull/668 finding test-design 1",
  "created": "2026-10-30",
  "status": "active"
}
---
When a map key gains a part (an attempt number, a repository), a test holds two keys that differ only in that part, so code that builds the part from a constant or leaves it out fails a test.
