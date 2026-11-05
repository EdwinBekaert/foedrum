// Cargo's manifest for the system map (ADR 0320).

import type { ManifestReader } from './manifest-reader.ts';

export const cargoManifest: ManifestReader = {
  ecosystem: 'Cargo',
  matches: () => {
    throw new Error('not implemented');
  },
  read: () => {
    throw new Error('not implemented');
  },
};
