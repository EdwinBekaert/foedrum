---
{
  "id": "outside-values-parsed-never-cast",
  "scope": {
    "globs": [
      "src/**/*.ts"
    ],
    "lens": "correctness"
  },
  "kind": "semantic",
  "source": "https://github.com/EdwinBekaert/foedrum/issues/749",
  "created": "2026-11-01",
  "status": "active"
}
---
A value from outside (JSON, a process's output, a model's text, a thrown value) is parsed with a schema or read through a shared helper, never cast; a helper is shared before a second copy is written.
