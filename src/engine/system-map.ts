// The system map (ADR 0317): what each repository of the Brewery publishes and which other one it
// depends on, read from its manifests at its base with git and no model, and written as the lines
// the planners' repositories input and `foedrum doctor` show. Each ecosystem is one reader in
// `READERS`; the core knows none of them.

import type { SystemMapEntry } from '../schemas/system-map.ts';
import type { Git } from '../workspace/git.ts';

/** A manifest as git gave it: its text, or why it could not be read. */
export type ManifestFile = { path: string } & ({ text: string } | { unread: string });

export const entryOf = (
  _files: readonly ManifestFile[],
  _modules: readonly string[],
  _leftFiles = 0,
): SystemMapEntry => {
  throw new Error('not implemented');
};

export const manifestsAt =
  (_git: Git) =>
  async (
    _clone: string,
    _commit: string,
    _signal?: AbortSignal,
  ): Promise<{ files: ManifestFile[]; left: number }> => {
    throw new Error('not implemented');
  };

/** A repository of the Brewery as the map names it, with its entry when one is recorded. */
export interface MappedRepository {
  repo: string;
  description?: string;
  entry?: SystemMapEntry;
}

export const mapLines = (
  _repository: MappedRepository,
  _all: readonly MappedRepository[],
): string[] => {
  throw new Error('not implemented');
};

export const cappedMap = (
  _blocks: readonly { line: string; map: readonly string[] }[],
  _max = 1500,
): string[] => {
  throw new Error('not implemented');
};
