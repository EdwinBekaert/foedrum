// The claim marks and the release of a claimed target-repository issue as the driver's effects
// (ADR 0043, #103).

import type { DriverEffects } from './driver.ts';
import type { Claimant, ClaimHost } from './issue-claims.ts';

/** The code host side of an issue's marks. */
export interface IssueMarks {
  assignees(repo: string, issue: number, signal?: AbortSignal): Promise<readonly string[]>;
  assign(repo: string, issue: number, login: string, signal?: AbortSignal): Promise<void>;
  labels(repo: string, issue: number, signal?: AbortSignal): Promise<readonly string[]>;
  addLabel(repo: string, issue: number, label: string, signal?: AbortSignal): Promise<void>;
  removeLabel(repo: string, issue: number, label: string, signal?: AbortSignal): Promise<void>;
  findComment(
    repo: string,
    issue: number,
    marker: string,
    signal?: AbortSignal,
  ): Promise<number | undefined>;
  comment(repo: string, issue: number, body: string, signal?: AbortSignal): Promise<number>;
}

export const effectMarker = (_key: string): string => {
  throw new Error('not implemented');
};

export interface ClaimEffectsOptions {
  claimant: Claimant;
  marks: IssueMarks;
  claims: ClaimHost;
  deadlineMs?: number;
}

export const claimEffects = (_options: ClaimEffectsOptions): DriverEffects => {
  throw new Error('not implemented');
};
