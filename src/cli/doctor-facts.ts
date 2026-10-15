// `foedrum doctor`, the shell (ADR 0021): finds each tool through PATH and asks it for its
// version through the process runner. doctor.ts decides what the answers mean.

import type { ExecProcess } from '../platform/processes.ts';
import type { DoctorFacts } from './doctor.ts';

export interface DoctorShell {
  exec: ExecProcess;
  /** The file a command name runs, or `undefined` when it is not on PATH. */
  resolve: (name: string) => string | undefined;
  platform: NodeJS.Platform;
  kernelRelease: string;
  node: string;
  cwd: string;
}

export const gatherDoctorFacts = async (_shell: DoctorShell): Promise<DoctorFacts> => {
  throw new Error('not implemented');
};
