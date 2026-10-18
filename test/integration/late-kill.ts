// A loaded machine for the tests that kill real processes (#147): the kill starts a process of its
// own (taskkill on Windows) or waits out a grace period, and on a busy machine it takes effect
// late. This spawner runs the real kill `ms` late, so a test can show it waits for the processes
// to end, however long that takes, instead of giving them a fixed time (ADR 0070).

import { processSpawner, type Spawner } from '../../src/platform/processes.ts';

/** The real spawner, with every kill of a tree carried out `ms` late. */
export const lateKill = (ms: number): Spawner => ({
  ...processSpawner,
  killTree: (pid) => {
    setTimeout(() => processSpawner.killTree(pid), ms);
  },
});
