// A fake "blocked by" read for a fake `TargetTracker`: the intake reads an issue's blockers only
// when its listing counts some, so a test about something else lists none and the read must never run.

import type { TargetTracker } from '../../src/engine/intake.ts';

/** A `blockers` that fails the test that calls it: its issues' listings count no blocker. */
export const blockersNotRead: TargetTracker['blockers'] = async (repo, issue) => {
  throw new Error(`The blockers of ${repo}#${issue} were read, but its listing counts none`);
};
