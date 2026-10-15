// Process checks that differ between operating systems (architecture §13).

export type Kill = (pid: number, signal: 0) => void;

export interface KillTreeOptions {
  platform?: NodeJS.Platform;
  /** Sends a signal to a process, or to a process group when `pid` is negative. */
  signal?: (pid: number, signal: NodeJS.Signals) => void;
  /** Runs `taskkill /PID <pid> /T /F` (Windows). */
  taskkill?: (pid: number) => void;
}

/**
 * Kills a process and every process it started. On Windows through taskkill; elsewhere the
 * process must lead its own process group (spawned with `detached: true`), which is killed.
 */
export const killProcessTree = (_pid: number, _options: KillTreeOptions = {}): void => {
  throw new Error('not implemented');
};

// Signal 0 checks that a process exists without touching it. EPERM means it exists but
// belongs to another user, so it counts as alive.
export const isPidAlive = (pid: number, kill: Kill = process.kill): boolean => {
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};
