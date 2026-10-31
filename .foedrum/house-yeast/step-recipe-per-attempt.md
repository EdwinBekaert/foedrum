---
{
  "id": "step-recipe-per-attempt",
  "scope": {
    "globs": [
      "src/engine/**/*.ts"
    ]
  },
  "kind": "semantic",
  "source": "https://github.com/EdwinBekaert/foedrum/pull/426 finding 1 (correctness), https://github.com/EdwinBekaert/foedrum/pull/701 finding correctness 2",
  "created": "2026-10-31",
  "status": "active"
}
---
A batch's folded steps keep the attempts of every recipe it brewed, since a person can choose another recipe; code that reads a step's definition for an attempt takes the recipe the attempt was scheduled under from the events, never batch.recipe alone.
