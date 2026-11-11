---
{
  "id": "every-problem-at-once-tested-with-two",
  "scope": {
    "globs": [
      "test/**"
    ],
    "lens": "test-design"
  },
  "kind": "semantic",
  "source": "https://github.com/EdwinBekaert/foedrum/pull/431 finding 1 (test-design, round 2), https://github.com/EdwinBekaert/foedrum/pull/1003 finding 1 (correctness)",
  "created": "2026-11-11",
  "status": "active"
}
---
A load that promises every problem at once has a test with two of its inputs broken together that asserts a line for each, so giving up at the first problem fails a test.
