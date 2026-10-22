// The personal denylist's shell for the local gate (ADR 0114, ADR 0021): reads the list and the
// commits a push would send, through git with the process runner; scripts/denylist/core.ts
// decides.

import type { DenylistState } from '../src/platform/denylist.ts';
import type { RunProcess } from './process-runner.ts';

/** Each git call's deadline: a local, read-only log should answer within seconds. */
export const DENYLIST_GIT_TIMEOUT_MS = 30_000;

/**
 * Why `git push` in `dir` may not run: the commits it would send hold a word on the list, the
 * list cannot be read, or git cannot show the commits. Undefined without a list.
 */
export const pushRefusal =
  (_readList: () => DenylistState, _runProcess: RunProcess) =>
  async (_dir: string): Promise<string | undefined> => {
    throw new Error('not implemented');
  };
