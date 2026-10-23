// `foedrum resume` on a running batch (ADR 0127): the interactive driver of that batch, on the
// wiring `foedrum serve` and `foedrum brew` share, under an owner of its own.

import type { Surface } from '../schemas/events.ts';
import type { ServeShell } from './serve.ts';
import type { ServeSetup } from './serve-config.ts';

/** The step of a running batch whose session `foedrum resume` continues, as whom, and who asked. */
export interface RunningResume {
  batchId: string;
  stepId: string;
  /** The driver's owner: its lock's and its leases' (ADR 0037). */
  owner: string;
  by: string;
  via: Surface;
}

/** Takes the batch over, drives it until the resumed attempt ended, and lets it go; 0 when it did. */
export const runResumeRunning = async (
  _setup: ServeSetup,
  _shell: ServeShell,
  _request: RunningResume,
): Promise<number> => {
  throw new Error('not implemented');
};
