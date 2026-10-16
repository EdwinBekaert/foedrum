// Lowers a process's priority to below normal on a developer's machine (#140), so the test
// processes of npm test, npm run check and /brew-review leave the terminal and other sessions
// room to take input. Child processes inherit the priority on Windows, macOS and Linux. CPU time,
// which the per-file budget measures (ADR 0036), does not change with priority.

export interface PriorityOptions {
  env: NodeJS.ProcessEnv;
  // os.getPriority and os.setPriority for this process; injected, so tests pass fakes.
  getPriority: () => number;
  setPriority: (priority: number) => void;
}

export const lowerPriority = (_options: PriorityOptions): void => {
  throw new Error('not implemented');
};
