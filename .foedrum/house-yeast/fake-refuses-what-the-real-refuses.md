---
{
  "id": "fake-refuses-what-the-real-refuses",
  "scope": {
    "globs": [
      "test/**/*.test.ts"
    ],
    "lens": "test-design"
  },
  "kind": "semantic",
  "source": "https://github.com/EdwinBekaert/foedrum/pull/451 finding 3, https://github.com/EdwinBekaert/foedrum/pull/1048 Brett mutant 5",
  "created": "2026-11-13",
  "status": "active"
}
---
A fake of an engine interface throws for the inputs the real implementation throws for, such as a step id it has no deadline for, so a test through the fake catches code that passes them.
