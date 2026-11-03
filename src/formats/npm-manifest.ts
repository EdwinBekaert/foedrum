// npm's manifest for the system map (ADR 0317): `package.json`'s name is the package a repository
// publishes, and each dependency field's entries what it depends on, a git URL or a folder included.

import type { ManifestReader } from './manifest-reader.ts';

export const npmManifest: ManifestReader = {
  ecosystem: 'npm',
  matches: () => {
    throw new Error('not implemented');
  },
  read: () => {
    throw new Error('not implemented');
  },
};
