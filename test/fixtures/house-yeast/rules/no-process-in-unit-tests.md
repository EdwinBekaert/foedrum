---
{
  "id": "no-process-in-unit-tests",
  "scope": { "globs": ["test/unit/**"] },
  "kind": "structural",
  "source": "https://github.com/acme/foedrum/pull/102#discussion_r2",
  "created": "2026-10-10",
  "status": "active"
}
---
A unit test never imports `node:child_process`.
