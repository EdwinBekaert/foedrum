---
{
  "id": "windows-program-extensions-read-alike",
  "scope": {
    "globs": [
      "src/**/*.ts"
    ],
    "language": "typescript"
  },
  "kind": "semantic",
  "source": "https://github.com/EdwinBekaert/foedrum/pull/443 finding 1, https://github.com/EdwinBekaert/foedrum/pull/1002 finding 1 (cross-platform)",
  "created": "2026-11-11",
  "status": "active"
}
---
Every reading that recognises a program by name in a command line compares its file name in lower case, without a folder or a Windows extension (.exe, .cmd, .bat), as the shell that runs the line finds it.
