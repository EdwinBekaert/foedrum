// `foedrum recipe`'s effects at once (ADR 0355): the batch's due effects, its recipe label and
// status comment among them, applied by a driver of its own on the wiring `foedrum serve` and
// `foedrum brew` share, which starts no attempt and lets the batch go.

import { releaseBatch } from '../engine/batch-leases.ts';
import type { DriverNotice } from '../engine/driver.ts';
import { messageOf } from '../platform/errors.ts';
import { closeOpened, type Opened, wireDriver } from './driver-wiring.ts';
import { formatNotice, type ServeShell } from './serve.ts';
import type { ServeSetup } from './serve-config.ts';

/** The batch whose effects go out now, and the owner of the driver that applies them. */
interface EffectsRequest {
  batchId: string;
  owner: string;
}

const SHOWN = 'the recipe label and status comment go up at';

/** The line of effects that did not go out, and why. */
export const later = (why: string): string =>
  `${SHOWN} the next foedrum brew or foedrum serve: ${why}`;

/** Applies `batchId`'s due effects; the lines to say, none when they all went out. */
export const runApplyEffects = async (
  setup: ServeSetup,
  shell: ServeShell,
  { batchId, owner }: EffectsRequest,
): Promise<string[]> => {
  const lines: string[] = [];
  let failed = false;
  const report = (notice: DriverNotice): void => {
    if (notice.kind === 'effect_failed' || notice.kind === 'batch_effects_failed') failed = true;
    lines.push(formatNotice(notice));
  };
  let opened: Opened;
  try {
    opened = { lock: shell.lock(setup.workRoot, { brewery: setup.brewery, owner }) };
  } catch (error) {
    return [later(messageOf(error))];
  }
  try {
    const { store, driver } = await wireDriver(setup, shell, opened, {
      takes: (id) => id === batchId,
      drivesOn: () => false,
      say: (line) => lines.push(line),
      report,
    });
    // A driver that holds it applies them at its next tick.
    const holder = store
      .batchLeases(shell.clock())
      .find((lease) => lease.batchId === batchId && lease.owner !== owner);
    if (holder !== undefined) {
      return [...lines, `${SHOWN} the next tick of ${holder.owner}, which holds the batch`];
    }
    try {
      // The effects alone: no tick, so nothing is driven and no attempt starts.
      await driver.applyEffects();
    } finally {
      store.withTransaction((tx) => releaseBatch(tx, batchId, owner));
    }
    return failed ? [...lines, later('an effect failed')] : lines;
  } catch (error) {
    return [...lines, later(messageOf(error))];
  } finally {
    closeOpened(opened);
  }
};
