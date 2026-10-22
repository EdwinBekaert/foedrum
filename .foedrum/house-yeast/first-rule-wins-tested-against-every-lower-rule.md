---
{
  "id": "first-rule-wins-tested-against-every-lower-rule",
  "scope": {
    "globs": [
      "src/engine/brewer-runner.ts",
      "src/brewers/*.ts"
    ]
  },
  "kind": "semantic",
  "source": "https://github.com/EdwinBekaert/foedrum/pull/346 finding 4 (test-design, round 2), https://github.com/EdwinBekaert/foedrum/pull/371 finding 1 (correctness, second round)",
  "created": "2026-10-22",
  "status": "active"
}
---
A rule in a first-rule-wins chain such as settleAttempt is tested against every rule below it, process exits included, so moving it down the chain fails a test.
