// .NET's manifests for the system map (ADR 0317): a project file's package id, its package and
// project references, and a solution's projects outside the repository.

import type { ManifestReader } from './manifest-reader.ts';

export const dotnetManifest: ManifestReader = {
  ecosystem: '.NET',
  matches: () => {
    throw new Error('not implemented');
  },
  read: () => {
    throw new Error('not implemented');
  },
};
