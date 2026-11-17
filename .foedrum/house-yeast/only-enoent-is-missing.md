---
{
  "id": "only-enoent-is-missing",
  "scope": {
    "language": "typescript"
  },
  "kind": "semantic",
  "source": "https://github.com/EdwinBekaert/foedrum/pull/340 finding 13 (correctness, round 2), https://github.com/EdwinBekaert/foedrum/pull/1140 finding 7",
  "created": "2026-11-17",
  "status": "active"
}
---
A read that falls back to empty when a file or folder is missing does so only for ENOENT; any other error is reported, so an unreadable file is never taken for an absent one.
