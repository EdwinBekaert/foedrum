// Process checks that differ between operating systems (architecture §13).

export type Kill = (pid: number, signal: 0) => void;

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
