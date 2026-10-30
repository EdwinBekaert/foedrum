---
{
  "id": "fallback-tested-where-only-it-answers",
  "scope": {
    "globs": [
      "src/**/*.ts"
    ],
    "lens": "test-design"
  },
  "kind": "semantic",
  "source": "https://github.com/EdwinBekaert/foedrum/pull/667 finding test-design 1, https://github.com/EdwinBekaert/foedrum/pull/668 finding test-design 2",
  "created": "2026-10-30",
  "status": "active"
}
---
A lookup with a fallback (`a ?? b`) has a test where only the fallback can give the expected value, since tests whose state always fills the first value, or that expect undefined, pass with the fallback removed.
