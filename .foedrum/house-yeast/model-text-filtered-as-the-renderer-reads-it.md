---
{
  "id": "model-text-filtered-as-the-renderer-reads-it",
  "scope": {
    "globs": [
      "src/engine/**"
    ],
    "language": "typescript"
  },
  "kind": "semantic",
  "source": "https://github.com/EdwinBekaert/foedrum/pull/450 finding security 1-3, correctness round 2, https://github.com/EdwinBekaert/foedrum/pull/490 finding 1 (security, round 1 and 2)",
  "created": "2026-10-25",
  "status": "active"
}
---
Code that defuses model text before GitHub renders it reads the text as GitHub's renderer does (CommonMark line ends, ASCII word boundaries, emphasis delimiters, character references, blocks a container ends, constructs that run over the lines of a paragraph or are read before a code span), and leaves the text out, or treats it as text, where it cannot tell, since a reading that differs from the renderer's lets the text through.
