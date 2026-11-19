---
{
  "id": "script-option-through-a-tested-function",
  "scope": {
    "lens": "design-conformance"
  },
  "kind": "semantic",
  "source": "https://github.com/EdwinBekaert/foedrum/issues/1094",
  "created": "2026-11-19",
  "status": "active"
}
---
A script's command line is read by a function in its core module that a unit test runs, with a red step: the script itself only passes `process.argv` to it and acts on its values or its refusal, so no option or its error path is left untested wiring.
