// `foedrum doctor`'s system map (ADR 0317): each repository of foedrum.jsonc read in its clone at
// `origin/<base>` with the readers the planners' map is recorded with, so a person sees what they
// read, and at which commit.

import type { SystemMapEntry } from '../schemas/system-map.ts';
import type { Git } from '../workspace/git.ts';

/** A repository of the map as doctor read it: its entry at a commit, or why it could not. */
export interface DoctorMapRepository {
  repo: string;
  base: string;
  description?: string;
  read: { commit: string; entry: SystemMapEntry } | { unread: string };
}

export interface DoctorMapSources {
  git: Git;
  home: string;
  cwd: string;
  /** The text of the file at `path`, or undefined when there is none. */
  readFile: (path: string) => string | undefined;
  /** Whether a clone is there to read. */
  exists: (path: string) => boolean;
}

export const readDoctorMap = async (_sources: DoctorMapSources): Promise<DoctorMapRepository[]> => {
  throw new Error('not implemented');
};
