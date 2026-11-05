---
{
  "id": "re-entered-step-counts-per-round",
  "scope": {
    "globs": [
      "src/engine/**/*.ts"
    ],
    "lens": "correctness"
  },
  "kind": "semantic",
  "source": "https://github.com/EdwinBekaert/foedrum/pull/730 finding 14, https://github.com/EdwinBekaert/foedrum/pull/831 finding correctness 1",
  "created": "2026-11-05",
  "status": "active"
}
---
A step that a person's choice or a route schedules again after it succeeded counts its attempts since its latest success, not over the batch's life, so its earlier successes never exhaust the attempts of a later round.
