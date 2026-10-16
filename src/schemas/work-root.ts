// The files in a work root that say which Brewery it belongs to and who holds a driver's lock
// (ADR 0037).

import { Repo } from './events.ts';
import { z } from './zod.ts';

/** `<workRoot>/brewery.json`: the Brewery the work root belongs to. */
export const BreweryMarker = z.strictObject({ brewery: Repo });
export type BreweryMarker = z.infer<typeof BreweryMarker>;

/** `<workRoot>/drivers/<owner>.holder.json`: who took a driver's lock, for a refusal's message. */
export const DriverHolder = z.strictObject({
  pid: z.int().positive(),
  startedAt: z.iso.datetime(),
});
export type DriverHolder = z.infer<typeof DriverHolder>;
