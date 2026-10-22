---
{
  "id": "lease-deadline",
  "scope": { "globs": ["src/engine/**"], "language": "typescript" },
  "kind": "semantic",
  "source": "https://github.com/acme/foedrum/pull/101#discussion_r1",
  "created": "2026-10-01",
  "status": "active"
}
---
Every lease the engine takes has a deadline, and the batch that holds it is Stuck when the deadline passes.
