---
{
  "id": "each-guard-condition-has-its-own-case",
  "scope": {
    "language": "typescript",
    "lens": "test-design"
  },
  "kind": "semantic",
  "source": "https://github.com/EdwinBekaert/foedrum/pull/506 finding test-design 1, https://github.com/EdwinBekaert/foedrum/pull/517 finding 1 (test-design, round 2)",
  "created": "2026-10-25",
  "status": "active"
}
---
A guard made of several conditions (a phase check, an outcome check, a walk back over retries or answers, a repository match) has a test for each condition that only that condition rejects, so deleting or loosening any one of them fails a test.
