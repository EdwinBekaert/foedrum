// The `release` input of a sub-order's batch (ADR 0291): for each `release` blocker of its
// sub-order, the release that made it ready, as the code host wrote it, with the blocker's merged
// pull requests. Foedrum parses no version: the brewer reads it from the released repository.

import { findSecrets } from '../formats/secrets.ts';
import type { Batch, Release, State } from './fold.ts';
import { mergedBefore, releaseAfterMerge } from './ready-set.ts';

/** The releases a batch waited for, each tag as written, and the text its brewers read. */
export interface ReleaseInput {
  releases: readonly { repo: string; version: string }[];
  text: string;
}

/**
 * Release notes, the released repository's text, with every line that looks like a secret left
 * out, and a last line that says how many were (the gravity tail's way).
 */
const notesOf = (notes: string): string[] => {
  const kept = notes.split('\n').filter((line) => findSecrets(line, () => false).length === 0);
  const left = notes.split('\n').length - kept.length;
  if (left === 0) return kept;
  const lines = left === 1 ? '1 line' : `${left} lines`;
  return [...kept, '', `(${lines} of the notes left out: they looked like secrets)`];
};

/** The section of one release `issue` waited for, with the pull requests of `blockedBy` it holds. */
const sectionOf = (issue: number, blockedBy: number, release: Release, pulls: string[]) => [
  `#### The release of ${release.repo} that #${issue} waited for`,
  `- Tag, as written: ${release.version}`,
  release.url === undefined
    ? '- A tag with no release on the code host: no release page, no notes'
    : `- Release: ${release.url}`,
  ...pulls.map((pull) => `- Merged pull request of #${blockedBy}: ${pull}`),
  ...(release.notes === undefined ? [] : ['- Notes:', '', ...notesOf(release.notes)]),
];

/**
 * The `release` input of `batch`, or undefined when it is no sub-order's or its sub-order waits on
 * no release (ADR 0064): for each `release` blocker, the release the ready set counted.
 */
export const releaseInput = (state: State, batch: Batch): ReleaseInput | undefined => {
  if (batch.parentBatchId === undefined) return undefined;
  const subOrder = state.subOrders.get(batch.issue);
  if (subOrder === undefined) return undefined;
  const releases: { repo: string; version: string }[] = [];
  const sections: string[][] = [];
  for (const { subOrder: issue, blockedBy, kind } of state.orders.get(subOrder.order)
    ?.dependencies ?? []) {
    if (issue !== batch.issue || kind !== 'release') continue;
    const release = releaseAfterMerge(state, blockedBy);
    if (release === undefined) continue;
    releases.push({ repo: release.repo, version: release.version });
    sections.push(
      sectionOf(issue, blockedBy, release, mergedBefore(state, blockedBy, release.seq)),
    );
  }
  if (releases.length === 0) return undefined;
  return { releases, text: sections.map((lines) => lines.join('\n')).join('\n\n') };
};
