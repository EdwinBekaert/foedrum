// `foedrum recipe`'s effects at once (ADR 0355): the batch's due effects, its recipe label and
// status comment among them, applied by a driver of its own on the wiring `foedrum serve` and
// `foedrum brew` share, which starts no attempt and lets the batch go.

import type { ServeShell } from './serve.ts';
import type { ServeSetup } from './serve-config.ts';

/** The batch whose effects go out now, and the owner of the driver that applies them. */
export interface EffectsRequest {
  batchId: string;
  owner: string;
}

/** Applies `batchId`'s due effects; the lines to say, none when they all went out. */
export const runApplyEffects = async (
  _setup: ServeSetup,
  _shell: ServeShell,
  _request: EffectsRequest,
): Promise<string[]> => {
  throw new Error('not implemented');
};
