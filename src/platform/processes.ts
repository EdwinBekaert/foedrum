// Process checks that differ between operating systems (architecture §13).

import { execFile } from 'node:child_process';

export type Kill = (pid: number, signal: 0) => void;

export interface KillTreeOptions {
  platform?: NodeJS.Platform;
  /** Sends a signal to a process, or to a process group when `pid` is negative. */
  signal?: (pid: number, signal: NodeJS.Signals) => void;
  /** Runs `taskkill /PID <pid> /T /F` (Windows). */
  taskkill?: (pid: number) => void;
}

/** Spawn options a process needs so that killProcessTree can end its whole tree. */
export const killableSpawnOptions = (
  platform: NodeJS.Platform = process.platform,
): { detached: boolean } => ({
  // Its own process group outside Windows; taskkill finds the tree on Windows.
  detached: platform !== 'win32',
});

/**
 * Kills a process and every process it started. On Windows through taskkill; elsewhere the
 * process must lead its own process group (spawned with `detached: true`), which is killed.
 */
export const killProcessTree = (pid: number, options: KillTreeOptions = {}): void => {
  const {
    platform = process.platform,
    signal = (target, name) => process.kill(target, name),
    taskkill = (target) => {
      execFile('taskkill', ['/PID', String(target), '/T', '/F'], { windowsHide: true }, () => {});
    },
  } = options;
  if (platform === 'win32') {
    taskkill(pid);
    return;
  }
  // The group first; a process that leads no group is killed on its own. Gone is fine.
  for (const target of [-pid, pid]) {
    try {
      signal(target, 'SIGKILL');
      return;
    } catch {
      // try the next target
    }
  }
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
