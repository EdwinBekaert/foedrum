import { execFileSync } from 'node:child_process';
import { chmodSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Makes a folder and everything in it read-only, as Windows sometimes leaves a worktree record:
// the ReadOnly attribute on Windows, no write bits elsewhere. Starts a process on Windows, so it
// is for integration tests only (ADR 0021).
export const makeReadOnly = (path: string): void => {
  if (statSync(path).isDirectory()) {
    for (const entry of readdirSync(path)) makeReadOnly(join(path, entry));
  }
  if (process.platform === 'win32') execFileSync('attrib', ['+R', path]);
  else chmodSync(path, statSync(path).mode & ~0o222);
};
