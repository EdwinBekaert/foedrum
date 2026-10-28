---
{
  "id": "read-option-groups-as-the-parser-does",
  "scope": {
    "globs": [
      "scripts/precheck.ts",
      "scripts/denylist.ts"
    ]
  },
  "kind": "semantic",
  "source": "https://github.com/EdwinBekaert/foedrum/pull/353 finding security 2, https://github.com/EdwinBekaert/foedrum/pull/635 finding 1",
  "created": "2026-10-28",
  "status": "active"
}
---
Code that reads another tool's command-line options reads every option it looks for in all the forms that tool's flag parser takes: after other short options in one group (-iF value), joined to the option, after =, and a long option by any unique prefix, with options that take a value taking the next word.
