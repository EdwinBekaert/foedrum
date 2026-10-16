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
- `runner/`: one file per way of importing the real process runner (`spawnProcess` or
  `execProcess` from `src/platform/processes.ts` or `scripts/process-runner.ts`: named,
  namespace, dynamic `import()`, `require`, a named and an `export *` re-export from a helper). Its `clean/` folder imports only the
  runner's types, the runner with a fake spawner and the module's other helpers.
- `stream-runner/`: a file that imports `streamProcess`, the runner for long streams, which must be
  reported, and one that imports only `streamProcessWith`, which must not be.

Biome skips this folder: the bare `child_process` specifier is a deliberate lint error here.
