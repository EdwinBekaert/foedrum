// The close of a Brewery issue whose work merged (ADR 0296): a target repository's pull request
// names no Brewery issue, so no `Closes` line closes it on the merge; the engine does, through the
// ledger, once every pull request of the issue's batch merged.

import type { IssueMarks } from './claim-effects.ts';
import type { DriverEffects } from './driver.ts';

export interface BreweryClosesOptions {
  marks: Pick<IssueMarks, 'findComment' | 'comment' | 'issueState' | 'setIssueState'>;
  /** The Brewery repository, `owner/name`. */
  brewery: string;
}

export const breweryCloseEffects = (_options: BreweryClosesOptions): DriverEffects => {
  throw new Error('not implemented');
};
