// Loaded through scripts/test-cpu-time.ts, the preload npm test runs in every test process: unit,
// property and chaos tests start no processes (ADR 0021), so in a test process the functions of
// node:child_process that start one throw instead (#111).

// The functions of node:child_process that start a process.
export const PROCESS_STARTS = [
  'spawn',
  'spawnSync',
  'exec',
  'execSync',
  'execFile',
  'execFileSync',
  'fork',
] as const;

// What refuseProcessStarts needs from node and node:test; injected, so tests pass fakes.
export interface RefuseOptions {
  env: NodeJS.ProcessEnv;
  // node:child_process's CommonJS module object, which its default export and require() return.
  childProcess: Record<string, unknown>;
  // node:module's syncBuiltinESMExports: copies the module object's properties to the named
  // exports of the built-in's ES module.
  syncBuiltinESMExports: () => void;
  // node:test's after: registers a hook that runs after the file's tests.
  after: (hook: () => void) => void;
}

export const refuseProcessStarts = (_options: RefuseOptions): void => {
  throw new Error('not implemented');
};
