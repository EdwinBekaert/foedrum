// The openPullRequest action as the driver runs it (ADR 0071): two effects of the batch in the
// ledger, the push of its task tree to the bottle branch and then the pull request on the code
// host, each found by its key before it is applied (ADR 0033), so a kill between them never
// pushes twice or opens two pull requests (I4). The attempt ends once both are recorded.

import type { OrderIssue } from '../github/order-text.ts';
import { PullRequestUrl } from '../schemas/events.ts';
import { remoteBranch } from '../workspace/attempt-worktrees.ts';
import type { Ending } from './decide.ts';
import { type DriverActions, repositoryOf } from './driver.ts';
import { effectKey } from './effect-key.ts';
import type { EffectTarget } from './effects.ts';
import type { State } from './fold.ts';
import {
  bottleBranch,
  openedPullRequest,
  pullRequestKey,
  pullRequestText,
  pushKey,
  type StepReport,
  stepReports,
} from './pull-request.ts';
import { taskTreeStart } from './task-tree.ts';

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

/** What one of the action's effects does, as `due` worked it out. */
type ActionEffect =
  | { kind: 'push'; push: BranchPush; revision: string; branch: string }
  | {
      kind: 'open';
      repo: string;
      request: Omit<PullRequestRequest, 'title' | 'body'>;
      order: OrderIssue;
      closes: { repo: string; issue: number };
      reports: readonly StepReport[];
    };

/** Where the action pushes from and opens into, or why it cannot run. */
type Plan =
  | { kind: 'run'; repository: PullRequestRepository; revision: string }
  | { kind: 'fail'; reason: string };

// The URL the code host answered, which the ledger keeps for good and `batch.on_tap` carries.
const pullRequestUrl = (url: string): string => {
  if (!PullRequestUrl.safeParse(url).success) {
    throw new Error(
      `The code host answered ${JSON.stringify(url)}, which is not a pull request URL`,
    );
  }
  return url;
};

export const pullRequestActions = (options: PullRequestActionsOptions): DriverActions => {
  const { brewery, repositories, host, orderTitle } = options;

  const plan = (state: State, batchId: string): Plan => {
    const batch = state.batches.get(batchId);
    if (batch === undefined) return { kind: 'fail', reason: `no batch ${batchId}` };
    try {
      const repository = repositoryOf(state, batchId, repositories);
      if (batch.taskTree === undefined) {
        return {
          kind: 'fail',
          reason: `batch ${batchId} has no commits to open a pull request with: no attempt that succeeded made a worktree`,
        };
      }
      // The base is never the start here: the task tree has moved (ADR 0066).
      const revision = taskTreeStart(batch, { repo: repository.repo, base: repository.base });
      return { kind: 'run', repository, revision };
    } catch (error) {
      return { kind: 'fail', reason: (error as Error).message };
    }
  };

  // The effect behind each key `due` gave; the driver asks `due` before it applies a key.
  const effects = new Map<string, ActionEffect>();
  const effectOf = (key: string): ActionEffect => {
    const effect = effects.get(key);
    if (effect === undefined) throw new Error(`No pull request effect ${key} is due`);
    return effect;
  };

  const targetOf = (effect: ActionEffect): EffectTarget => {
    switch (effect.kind) {
      case 'push': {
        const { push, revision, branch } = effect;
        return {
          // Pushed by a run before that was killed before it recorded the push.
          find: async (_key, signal) => {
            const commit = await push.commit(revision, signal);
            const tip = await push.remoteTip(branch, signal);
            return tip === commit ? { result: { branch, commit } } : undefined;
          },
          apply: async (_key, signal) => {
            const commit = await push.commit(revision, signal);
            await push.push(commit, branch, signal);
            return { branch, commit };
          },
        };
      }
      case 'open': {
        const { repo, request, order, closes, reports } = effect;
        return {
          find: async (_key, signal) => {
            const url = await host.find(repo, request.head, signal);
            return url === undefined ? undefined : { result: pullRequestUrl(url) };
          },
          apply: async (_key, signal) => {
            const text = pullRequestText({
              title: await orderTitle(order, signal),
              closes,
              reports,
            });
            return pullRequestUrl(await host.open(repo, { ...request, ...text }, signal));
          },
        };
      }
      default:
        return effect satisfies never;
    }
  };

  return {
    due: (state, { batchId }) => {
      const planned = plan(state, batchId);
      const batch = state.batches.get(batchId);
      if (planned.kind === 'fail' || batch === undefined) return [];
      const { repository, revision } = planned;
      const { repo } = repository;
      const branch = remoteBranch(brewery, bottleBranch(batchId, repo));
      const order =
        batch.repo === undefined
          ? { issue: batch.issue }
          : { issue: batch.issue, repo: batch.repo };
      effects.set(effectKey.encode(pushKey(batchId)), {
        kind: 'push',
        push: repository.push,
        revision,
        branch,
      });
      effects.set(effectKey.encode(pullRequestKey(batchId)), {
        kind: 'open',
        repo,
        request: { head: branch, base: repository.base },
        order,
        closes: { repo: batch.repo ?? brewery, issue: batch.issue },
        reports: stepReports(batch),
      });
      return [pushKey(batchId), pullRequestKey(batchId)];
    },
    target: {
      find: async (key, signal) => targetOf(effectOf(key)).find(key, signal),
      apply: async (key, signal) => targetOf(effectOf(key)).apply(key, signal),
    },
    ending: (state, { batchId }): Ending => {
      const planned = plan(state, batchId);
      if (planned.kind === 'fail')
        return { kind: 'failed', retryable: false, reason: planned.reason };
      const url = openedPullRequest(state, batchId);
      if (url === undefined) {
        return {
          kind: 'failed',
          retryable: true,
          reason: `the ledger has no pull request of batch ${batchId}`,
        };
      }
      return { kind: 'succeeded', output: { pullRequest: url } };
    },
  };
};
