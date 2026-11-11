// The cleanup's sweep of the Brewery's temporary folder (ADR 0380): `.foedrum/tmp/` in the
// Brewery's clone, where people and sessions keep scratch files and Foedrum writes nothing of its
// own. Each entry goes once nothing in it changed for 2 days, so a session still at work there
// keeps its folder.

/** How long nothing in an entry must have changed before the sweep removes it. */
export const TEMP_AGE_MS = 2 * 24 * 60 * 60 * 1000;

/** What a sweep removed, and what it could not remove, each by its name in the folder. */
export interface SweepReport {
  removed: string[];
  failed: { name: string; error: string }[];
}

/**
 * Removes each entry of `folder` whose newest file or folder inside changed more than
 * `TEMP_AGE_MS` before `now`; nothing when the folder is missing. A link is read as itself, never
 * followed.
 */
export const sweepTemp = async (_folder: string, _now: Date): Promise<SweepReport> => {
  throw new Error('not implemented');
};
