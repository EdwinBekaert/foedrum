# Test-layer guard fixtures

Input for `test/unit/check-test-layers.test.ts`: small source files that do or do not import
`node:child_process`, scanned by `scripts/check-test-layers.ts`. They are never run.

- `clean/`: no file imports `child_process` (one mentions it in a comment and a string).
- `spawning/`: one file per import form (named, namespace with a bare specifier, dynamic
  `import()`, `require`, re-export, side-effect import in a nested folder), a file that imports
  nothing, and a Markdown file that is not scanned.
- `test-dir/`: a `test/` folder in miniature. `property/`, `chaos/` and `helpers/` each have a
  file that imports `child_process` and must be reported. So do `integration/` and `fixtures/`,
  which must not be, because real processes are allowed there. `unit/` imports nothing.

Biome skips this folder: the bare `child_process` specifier is a deliberate lint error here.
