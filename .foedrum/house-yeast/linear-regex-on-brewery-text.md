---
{
  "id": "linear-regex-on-brewery-text",
  "scope": {
    "globs": [
      "src/**/*.ts"
    ],
    "lens": "security"
  },
  "kind": "semantic",
  "source": "https://github.com/EdwinBekaert/foedrum/pull/377 finding 4, https://github.com/EdwinBekaert/foedrum/pull/494 finding security 1",
  "created": "2026-10-25",
  "status": "active"
}
---
A regular expression run over text from a Brewery, an order, a repository or a model is linear in its input: no two adjacent quantifiers can match the same characters, and a global search whose run can fail after it starts only at the run's first character (a lookbehind), so a failed search does not rescan the run from each of its characters.
