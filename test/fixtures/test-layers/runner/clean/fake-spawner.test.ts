import {
  type ExecProcess,
  execProcessWith,
  isPidAlive,
  killProcessTree,
} from '../../../../../src/platform/processes.ts';

// The runner with a fake spawner, and the other helpers of the module, are fine.
export const exec: ExecProcess = execProcessWith({
  spawn: () => {
    throw new Error('no processes here');
  },
  killTree: () => {},
});
export const helpers = [isPidAlive, killProcessTree];
