---
paths:
  - "**/src/platform/**"
---

<!-- Generated from .foedrum/house-yeast/ by npm run house-yeast:rules; do not edit. -->

# House yeast

Rules learned from reviews of Foedrum's own pull requests (ADR 0122), for the files this session reads or changes (ADR 0271). Follow them where your change meets them: /brew-review looks for what they describe.

## sandbox-bounds-never-read-from-inside (semantic)

What a sandbox lets in (a bind, a read rule, a parameter) is never taken from a file the sandboxed code, or a brewer in any worktree, can write, unless something outside its reach vouches for it: a path counts as Foedrum's own only by its real path, directly in a folder only Foedrum writes.
