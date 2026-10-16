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

const REFUSED =
  'unit, property and chaos tests start no processes: inject a fake process runner, or move the test to test/integration/ (ADR 0021)';

// In a test process the runner started (it sets NODE_TEST_CONTEXT), replaces the functions that
// start a process with ones that throw. The runner loads the preload too and must keep starting
// the test files, so outside a test process nothing changes.
//
// The default export and require() return the module object, so replacing its properties covers
// them. A named import (`import { spawn } from 'node:child_process'`) reads the built-in's ES
// module, which copies the properties once, when something first imports it; syncBuiltinESMExports
// copies them again, so named imports refuse too, whether or not that happened before.
//
// Code under test may catch the throw: the process runner reports a process that could not start
// as a result. So the after hook fails the file when any start was refused, with the first call's
// stack, which shows the test and the imports that led to it.
export const refuseProcessStarts = ({
  env,
  childProcess,
  syncBuiltinESMExports,
  after,
}: RefuseOptions): void => {
  if (env.NODE_TEST_CONTEXT === undefined) return;
  const refused: Error[] = [];
  for (const name of PROCESS_STARTS) {
    childProcess[name] = () => {
      const error = new Error(`child_process.${name} refused: ${REFUSED}`);
      refused.push(error);
      throw error;
    };
  }
  syncBuiltinESMExports();
  after(() => {
    const [first] = refused;
    if (first === undefined) return;
    const starts = refused.length === 1 ? '1 process start' : `${refused.length} process starts`;
    throw new Error(
      `this file made ${starts}, refused because ${REFUSED}; the first:\n${first.stack}`,
    );
  });
};
