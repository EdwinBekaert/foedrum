// Lowers a process's priority to below normal on a developer's machine (#140), so the test
// processes of npm test, npm run check and /brew-review leave the terminal and other sessions
// room to take input. Child processes inherit the priority on Windows, macOS and Linux. CPU time,
// which the per-file budget measures (ADR 0036), does not change with priority.

import { constants, getPriority, setPriority } from 'node:os';

export interface PriorityOptions {
  env: NodeJS.ProcessEnv;
  // os.getPriority and os.setPriority for this process; injected, so tests pass fakes.
  getPriority: () => number;
  setPriority: (priority: number) => void;
}

const { PRIORITY_BELOW_NORMAL } = constants.priority;

// Outside CI, sets below normal unless the process already runs at that or lower (a higher
// number); raising it would need privileges. A refusal leaves the priority as it was: a test run
// at normal priority is slower for the desktop, not wrong.
export const lowerPriority = ({ env, getPriority, setPriority }: PriorityOptions): void => {
  if (env.CI !== undefined && env.CI !== '') return;
  try {
    if (getPriority() < PRIORITY_BELOW_NORMAL) setPriority(PRIORITY_BELOW_NORMAL);
  } catch {
    // Left as it was.
  }
};

// This process, through node:os.
export const lowerOwnPriority = (env: NodeJS.ProcessEnv): void =>
  lowerPriority({
    env,
    getPriority: () => getPriority(),
    setPriority: (value) => setPriority(value),
  });
