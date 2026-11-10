// Fake label events for a fake `TargetTracker` (ADR 0359): each label of a listed issue added by
// whoever opened it, so a test about something else needs no events of its own.

import type { TargetTracker } from '../../src/engine/intake.ts';
import type { TargetIssue } from '../../src/engine/issue-claims.ts';

/** `labelsAdded` of the issues `listed` gives for a repository, each label added by its author. */
export const addedByAuthor =
  (listed: (repo: string) => readonly TargetIssue[] | undefined): TargetTracker['labelsAdded'] =>
  async (repo, number) => {
    const found = listed(repo)?.find((each) => each.number === number);
    if (found === undefined) throw new Error(`404 the events of ${repo}#${number}`);
    return found.labels.map((label) => ({ label, by: found.author }));
  };
