// A repository's latest release on GitHub (ADR 0223): its latest published release, else its newest
// tag by its commit's date, and whether it holds a pull request's merge commit. REST reads are
// conditional (ADR 0052); everything it reads is untrusted input, checked field by field.

import type { ReleaseReader } from '../engine/releases.ts';
import type { GitHubClient } from './client.ts';
import type { GitHubReads } from './reads.ts';

export const githubReleaseReader = (_reads: GitHubReads, _client: GitHubClient): ReleaseReader => ({
  latest: async () => {
    throw new Error('not implemented');
  },
  holds: async () => {
    throw new Error('not implemented');
  },
});
