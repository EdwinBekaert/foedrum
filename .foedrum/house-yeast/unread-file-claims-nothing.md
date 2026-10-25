---
{
  "id": "unread-file-claims-nothing",
  "scope": {
    "language": "typescript",
    "lens": "correctness"
  },
  "kind": "semantic",
  "source": "https://github.com/EdwinBekaert/foedrum/pull/377 finding 2, https://github.com/EdwinBekaert/foedrum/pull/514 correctness finding 2 (round 2)",
  "created": "2026-10-25",
  "status": "active"
}
---
A report about a file's content says nothing of a file it could not read beyond that it could not: a comparison with an unread file is never worded as a match or a difference.
