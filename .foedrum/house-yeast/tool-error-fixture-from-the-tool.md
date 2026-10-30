---
{
  "id": "tool-error-fixture-from-the-tool",
  "scope": {
    "language": "typescript",
    "lens": "test-design"
  },
  "kind": "semantic",
  "source": "https://github.com/EdwinBekaert/foedrum/pull/627 finding 2 (test-design), https://github.com/EdwinBekaert/foedrum/pull/692 finding test-design 2 (round 2)",
  "created": "2026-10-30",
  "status": "active"
}
---
A test fixture that stands for another tool's or module's output (an error text, a report it prints) builds it from that tool or module when the test can call it in process, so the test breaks when the real format drifts.
