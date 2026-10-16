// A module that starts a process through a named import, as code under test may.
import { spawnSync } from 'node:child_process';

export const nodeVersion = (): string =>
  spawnSync(process.execPath, ['--version'], { encoding: 'utf8' }).stdout.trim();
