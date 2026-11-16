---
{
  "id": "scoped-refusal-has-an-accept-test-for-the-other-kind",
  "scope": {
    "language": "typescript",
    "lens": "test-design"
  },
  "kind": "semantic",
  "source": "https://github.com/EdwinBekaert/foedrum/pull/409 finding 19, https://github.com/EdwinBekaert/foedrum/pull/1093 finding 1",
  "created": "2026-11-16",
  "status": "active"
}
---
A refusal that applies to one kind of input only (a Brewery issue and not a target-repository issue of the same number, an option with one mode and not without it) has a test that the other kind is accepted, so dropping the guard that scopes it fails a test.
