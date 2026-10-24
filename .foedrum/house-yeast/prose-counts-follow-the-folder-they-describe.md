---
{
  "id": "prose-counts-follow-the-folder-they-describe",
  "scope": {
    "globs": [
      "defaults/lenses/**",
      "test/**",
      "docs/**",
      ".claude/**"
    ]
  },
  "kind": "semantic",
  "source": "https://github.com/EdwinBekaert/foedrum/pull/446 finding 1, https://github.com/EdwinBekaert/foedrum/pull/460 finding 1",
  "created": "2026-10-24",
  "status": "active"
}
---
A change that adds a file to a folder other code or a skill reads by glob (defaults/lenses/diff/) updates every prose count and list of that folder's files (the five default lenses), in skills, agent descriptions and test comments too, since the glob already reads the new file.
