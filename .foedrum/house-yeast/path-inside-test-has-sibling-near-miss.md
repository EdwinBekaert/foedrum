---
{
  "id": "path-inside-test-has-sibling-near-miss",
  "scope": {
    "language": "typescript"
  },
  "kind": "semantic",
  "source": "https://github.com/EdwinBekaert/foedrum/pull/379 finding test-design 1, https://github.com/EdwinBekaert/foedrum/pull/422 finding test-design 2",
  "created": "2026-10-23",
  "status": "active"
}
---
Code that decides whether a path lies inside a folder has a test with a sibling whose name starts with that folder's name (/home/adam beside /home/ada), and one with the root as the folder.
