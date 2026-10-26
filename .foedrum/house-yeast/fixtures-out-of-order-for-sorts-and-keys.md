---
{
  "id": "fixtures-out-of-order-for-sorts-and-keys",
  "scope": {
    "language": "typescript",
    "lens": "test-design"
  },
  "kind": "semantic",
  "source": "https://github.com/EdwinBekaert/foedrum/pull/426 finding (test-design, rounds 1 and 2), https://github.com/EdwinBekaert/foedrum/pull/539 finding 1 (test-design)",
  "created": "2026-10-26",
  "status": "active"
}
---
A test of a sort or of state kept per key feeds its input out of order and interleaved across keys, so dropping the sort, a tiebreak or the key fails it.
