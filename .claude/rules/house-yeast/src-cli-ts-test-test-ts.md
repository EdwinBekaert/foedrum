---
paths:
  - "**/src/cli/**/*.ts"
  - "**/test/**/*.test.ts"
---

<!-- Generated from .foedrum/house-yeast/ by npm run house-yeast:rules; do not edit. -->

# House yeast

Rules learned from reviews of Foedrum's own pull requests (ADR 0122), for the files this session reads or changes (ADR 0271). Follow them where your change meets them: /brew-review looks for what they describe.

## factory-wiring-tested-through-the-factory (semantic)

A dependency that a real-machine factory passes on (serveShell's runner, interactiveBrewerRunner's headless runner, the driver wiring's options) has a test through that factory, with a fake that answers before any real process starts, so dropping the dependency from the factory fails a test.
