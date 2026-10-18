// The openPullRequest action as the driver runs it (ADR 0071): two effects of the batch in the
// ledger, the push of its task tree to the bottle branch and then the pull request on the code
// host, each found by its key before it is applied (ADR 0033), so a kill between them never
// pushes twice or opens two pull requests (I4). The attempt ends once both are recorded.

import type { OrderIssue } from '../github/order-text.ts';
import type { DriverActions } from './driver.ts';

/** What Foedrum asks the code host to open. */
export interface PullRequestRequest {
  /** The branch in the repository itself, never a fork's. */
  head: string;
  base: string;
  title: string;
  body: string;
}

/** Where pull requests are opened (architecture §3.1). Every call stops when `signal` aborts. */
export interface PullRequestHost {
  /**
   * The URL of the pull request in `repo` whose head is its branch `head` and that the Brewery's
   * own identity opened, open or not, or `undefined`: keys and branch names are predictable, so a
   * pull request anyone else opened never counts.
   */
  find(repo: string, head: string, signal?: AbortSignal): Promise<string | undefined>;
  /** Opens the pull request; its URL. */
  open(repo: string, request: PullRequestRequest, signal?: AbortSignal): Promise<string>;
}

/** The pushes of a repository's clone to its remote. Every call stops when `signal` aborts. */
export interface BranchPush {
  /** The commit `revision` names in the clone; throws when it names none. */
  commit(revision: string, signal?: AbortSignal): Promise<string>;
  /** The commit the remote's branch `branch` points at, or `undefined` when it has no such branch. */
  remoteTip(branch: string, signal?: AbortSignal): Promise<string | undefined>;
  /** Pushes `commit` to the remote's branch `branch`, never by force. */
  push(commit: string, branch: string, signal?: AbortSignal): Promise<void>;
}

/** A repository a batch writes in: its base branch, and the pushes of its clone. */
export interface PullRequestRepository {
  repo: string;
  /** The branch the pull request goes into, as the remote names it (`main`). */
  base: string;
  push: BranchPush;
}

export interface PullRequestActionsOptions {
  /** The Brewery, `owner/name`: its pushed branches carry it (ADR 0043). */
  brewery: string;
  repositories: readonly PullRequestRepository[];
  host: PullRequestHost;
  /** The title of the order's issue, read as the effect applies. */
  orderTitle: (order: OrderIssue, signal?: AbortSignal) => Promise<string>;
}

export const pullRequestActions = (_options: PullRequestActionsOptions): DriverActions => {
  throw new Error('not implemented');
};
