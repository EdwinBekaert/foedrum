// Go's manifest for the system map (ADR 0320).

import type { ManifestReader } from './manifest-reader.ts';

export const goManifest: ManifestReader = {
  ecosystem: 'Go',
  matches: () => {
    throw new Error('not implemented');
  },
  read: () => {
    throw new Error('not implemented');
  },
};
