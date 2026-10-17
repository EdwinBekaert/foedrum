// Machine load in a test (#147). On a busy machine the OS takes the CPU away from a test process:
// wall time passes while the process runs no code and its event loop does not turn. `descheduled`
// does that on purpose, using no CPU time, so a test can show it does not depend on the wall
// clock (ADR 0070).

const cell = new Int32Array(new SharedArrayBuffer(4));

/** Blocks this thread for `ms` of wall time without using the CPU, as a loaded machine would. */
export const descheduled = (ms: number): void => {
  Atomics.wait(cell, 0, 0, ms);
};
