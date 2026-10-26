---
{
  "id": "sandbox-bounds-never-read-from-inside",
  "scope": {
    "globs": [
      "src/platform/**"
    ],
    "lens": "security"
  },
  "kind": "semantic",
  "source": "https://github.com/EdwinBekaert/foedrum/pull/357 finding 1 (security), https://github.com/EdwinBekaert/foedrum/pull/528 finding security 1 (rounds 1, 2 and 3)",
  "created": "2026-10-26",
  "status": "active"
}
---
What a sandbox lets in (a bind, a read rule, a parameter) is never taken from a file the sandboxed code, or a brewer in any worktree, can write, unless something outside its reach vouches for it: a path counts as Foedrum's own only by its real path, directly in a folder only Foedrum writes.
