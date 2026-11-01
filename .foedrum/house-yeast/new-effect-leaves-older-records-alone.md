---
{
  "id": "new-effect-leaves-older-records-alone",
  "scope": {
    "globs": [
      "src/engine/**/*.ts"
    ]
  },
  "kind": "semantic",
  "source": "https://github.com/EdwinBekaert/foedrum/pull/743 finding 13, https://github.com/EdwinBekaert/foedrum/pull/752 finding correctness 1 (round 1)",
  "created": "2026-11-01",
  "status": "active"
}
---
A new driver effect, which the driver asks of every batch in the store, is due only for batches that reached it under its own rule, so an ended batch from before it (a merged pull request, an older batch of the same issue) is never written again on upgrade.
