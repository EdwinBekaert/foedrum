---
{
  "id": "model-text-stays-on-its-line",
  "scope": {
    "globs": [
      "src/**/*.ts",
      "scripts/**/*.ts"
    ]
  },
  "kind": "semantic",
  "source": "https://github.com/EdwinBekaert/foedrum/pull/351 finding security 1, https://github.com/EdwinBekaert/foedrum/pull/683 finding 17",
  "created": "2026-10-30",
  "status": "active"
}
---
Output that an agent or a script reads line by line escapes the line breaks (line feed, U+2028, U+2029) of every value a model or an issue wrote, not only control characters, so such a value cannot forge a line of the command's own.
