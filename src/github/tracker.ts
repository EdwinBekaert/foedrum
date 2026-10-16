// The intake's reads of GitHub (ADR 0050, ADR 0052): the open issues of a target repository and how
// a pull request of a batch stands, both through conditional reads, so a poll that finds nothing
// new costs no rate limit. Everything it reads is untrusted input, checked field by field.

import type { TargetTracker } from '../engine/intake.ts';
import type { GitHubReads } from './reads.ts';

export const githubTargetTracker = (_reads: GitHubReads): TargetTracker => {
  throw new Error('not implemented');
};
