import type { RunProcess } from '../../../../../scripts/process-runner.ts';
import type { ExecProcess } from '../../../../../src/platform/processes.ts';

// Fake runners, typed like the real ones; spawnProcess and execProcess are only named here.
export const fakeRun: RunProcess = async () => ({ exitCode: 0, output: 'spawnProcess' });
export const fakeExec: ExecProcess = async () => ({
  exitCode: 0,
  stdout: '',
  stderr: '',
  output: 'execProcess',
});
