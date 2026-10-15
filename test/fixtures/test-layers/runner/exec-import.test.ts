import {
  type ExecOptions,
  execProcess,
} from '../../../../src/platform/processes.ts';

export const run = (options: ExecOptions) => execProcess('git', [], options);
