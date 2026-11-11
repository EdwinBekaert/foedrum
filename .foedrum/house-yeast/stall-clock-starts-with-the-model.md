---
{
  "id": "stall-clock-starts-with-the-model",
  "scope": {
    "globs": [
      "src/brewers/**/*.ts"
    ]
  },
  "kind": "semantic",
  "source": "https://github.com/EdwinBekaert/foedrum/pull/440 finding 1 (correctness, round 1), https://github.com/EdwinBekaert/foedrum/pull/1008 correctness finding 1",
  "created": "2026-11-11",
  "status": "active"
}
---
Work a brewer runner does before claude starts (an install, a plan) reports progress while it runs, and claude's stall clock starts when that work ends, so the stall limit judges only the model.
