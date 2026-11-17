---
{
  "id": "a-readme-shell-block-names-its-shell",
  "scope": {
    "language": "markdown"
  },
  "kind": "semantic",
  "source": "https://github.com/EdwinBekaert/foedrum/pull/515 finding 8 (cross-platform), https://github.com/EdwinBekaert/foedrum/pull/1139 finding 3",
  "created": "2026-11-17",
  "status": "active"
}
---
A block of commands a document tells a person to run says which shell it is written for when it uses a glob, a redirect or a `VAR=value cmd` prefix, and gives the PowerShell form beside it, which clears any variable it sets, since `$env:` lasts for the session.
