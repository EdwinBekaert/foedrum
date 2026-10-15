// Process checks that differ between operating systems (architecture §13).

export type Kill = (pid: number, signal: 0) => void;

export const isPidAlive = (_pid: number, _kill: Kill = process.kill): boolean => {
  throw new Error('not implemented');
};
