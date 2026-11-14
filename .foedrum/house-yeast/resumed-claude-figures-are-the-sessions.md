---
{
  "id": "resumed-claude-figures-are-the-sessions",
  "scope": {
    "language": "typescript"
  },
  "kind": "semantic",
  "source": "https://github.com/EdwinBekaert/foedrum/pull/459 finding 14 (design-conformance), https://github.com/EdwinBekaert/foedrum/pull/1059 finding correctness round 2",
  "created": "2026-11-14",
  "status": "active"
}
---
Code that adds up what claude reports across attempts treats a resumed run's figures and transcript as the session's so far, not the run's (ADR 0042, ADR 0175), and counts each session once.
