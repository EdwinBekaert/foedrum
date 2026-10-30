---
paths:
  - "**/src/engine/**"
---

<!-- Generated from .foedrum/house-yeast/ by npm run house-yeast:rules; do not edit. -->

# House yeast

Rules learned from reviews of Foedrum's own pull requests (ADR 0122), for the files this session reads or changes (ADR 0271). Follow them where your change meets them: /brew-review looks for what they describe.

## model-text-filtered-as-the-renderer-reads-it (semantic)

Code that defuses model text before GitHub renders it reads the text as GitHub's renderer does (CommonMark line ends, ASCII word boundaries, emphasis delimiters, character references, blocks a container ends, constructs that run over the lines of a paragraph or are read before a code span), and leaves the text out, or treats it as text, where it cannot tell, since a reading that differs from the renderer's lets the text through.
