// Machine load in a test (#147). On a busy machine the OS takes the CPU away from a test process:
// wall time passes while the process runs no code and its event loop does not turn. `descheduled`
// does that on purpose, using no CPU time, so a test can show it does not depend on the wall
// clock (ADR 0070).

import type { Timers } from '../../src/platform/processes.ts';

const cell = new Int32Array(new SharedArrayBuffer(4));

/** Blocks this thread for `ms` of wall time without using the CPU, as a loaded machine would. */
export const descheduled = (ms: number): void => {
  Atomics.wait(cell, 0, 0, ms);
};

/**
 * Polls `done` until it holds. The deadline only guards against a hang, so it is long: a loaded
 * machine may take many times longer than an idle one (ADR 0070).
 */
export const waitUntil = async (what: string, done: () => boolean, ms = 120_000): Promise<void> => {
  const until = performance.now() + ms;
  while (!done()) {
    if (performance.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((settle) => setTimeout(settle, 50));
  }
};

/**
 * Timers whose callbacks run when the test calls `fire`, never by the clock: a process runner
 * given these reaches its deadline when the test is ready, not when a loaded machine has started
 * its processes late (ADR 0070).
 */
export const cuedTimers = (): Timers & { fire: () => void } => {
  const pending = new Set<() => void>();
  return {
    set: (callback) => {
      pending.add(callback);
      return callback;
    },
    clear: (timer) => {
      pending.delete(timer as () => void);
    },
    fire: () => {
      if (pending.size === 0) throw new Error('no timer to fire');
      for (const callback of [...pending]) {
        pending.delete(callback);
        callback();
      }
    },
  };
};

/** The CPU time this process has used, in ms: what a performance check measures (ADR 0070). */
export const cpuTimeMs = (): number => {
  const { user, system } = process.cpuUsage();
  return (user + system) / 1000;
};
