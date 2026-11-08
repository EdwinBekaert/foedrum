// A pre-existing finding as a Brewery issue once its batch's pull requests merged (ADR 0356): one
// issue per finding a Taster raised and the step its findings route went back to left as there
// before the change (ADR 0191), each through the ledger and found by its key before it is applied
// (ADR 0033), with the label that marks it and no recipe.

import type { TastingFinding } from '../schemas/out-doc.ts';
import type { DriverEffects } from './driver.ts';
import type { State } from './fold.ts';
import type { SubIssues } from './sub-issues.ts';

/** The label of every issue a pre-existing finding opens (ADR 0356). */
export const PRE_EXISTING = 'foedrum:pre-existing';

/** Where the issues open: the Brewery's issues, and its labels. */
export interface PreExistingHost extends Pick<SubIssues, 'findIssue' | 'openIssue'> {
  /** Creates the label `label` in `repo`; one there already counts as made. */
  createLabel(repo: string, label: string, signal?: AbortSignal): Promise<void>;
}

export interface PreExistingIssueEffectsOptions {
  host: PreExistingHost;
  /** The Brewery repository, `owner/name`. */
  brewery: string;
}

/** An issue the ledger has for a pre-existing finding of a batch, and the finding. */
export interface FiledIssue {
  number: number;
  stepId: string;
  finding: TastingFinding;
}

/** The issues the ledger has for the pre-existing findings of `batchId`, in the order they are due. */
export const filedIssues = (_state: State, _batchId: string): FiledIssue[] => {
  throw new Error('not implemented');
};

/** Whether an issue of a pre-existing finding of `batchId` is due and not in the ledger yet. */
export const issuesLeft = (_state: State, _batchId: string): boolean => {
  throw new Error('not implemented');
};

/** The issue of each pre-existing finding of a batch whose pull requests merged, for the driver. */
export const preExistingIssueEffects = (
  _options: PreExistingIssueEffectsOptions,
): DriverEffects => {
  throw new Error('not implemented');
};
