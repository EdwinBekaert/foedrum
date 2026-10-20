// The openPullRequest action as the driver runs it (ADR 0071): two effects of the batch in the
// ledger, the push of its task tree to the bottle branch and then the pull request on the code
// host, each found by its key before it is applied (ADR 0033), so a kill between them never
// pushes twice or opens two pull requests (I4). The attempt ends once both are recorded.

import type { IsCommit } from '../formats/secrets.ts';
import type { OrderIssue } from '../github/order-text.ts';
import { PullRequestUrl } from '../schemas/events.ts';
import type { ScanFinding } from '../schemas/store.ts';
import { MAX_REFUSED, PushResult } from '../schemas/store.ts';
import { remoteBranch } from '../workspace/attempt-worktrees.ts';
import type { Ending } from './decide.ts';
import { type DriverActions, repositoryOf } from './driver.ts';
import { effectKey } from './effect-key.ts';
import type { EffectTarget } from './effects.ts';
import type { State } from './fold.ts';
import {
  bottleBranch,
  knownCommits,
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
  /** Whether the commit `commit` is the commit `of` or one of its ancestors: both full shas. */
  isAncestor(commit: string, of: string, signal?: AbortSignal): Promise<boolean>;
  /** The commit the remote's branch `branch` points at, or `undefined` when it has no such branch. */
  remoteTip(branch: string, signal?: AbortSignal): Promise<string | undefined>;
  /** Pushes `commit` to the remote's branch `branch`, never by force. */
  push(commit: string, branch: string, signal?: AbortSignal): Promise<void>;
  /**
   * What the commits from `base` to `commit` (both full shas) would publish that looks like a
   * secret, or that the scan cannot read: nothing when they may go (ADR 0079).
   */
  secretScan(base: string, commit: string, signal?: AbortSignal): Promise<ScanFinding[]>;
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
  | { kind: 'push'; push: BranchPush; revision: string; base: string; branch: string }
  | {
      kind: 'open';
      repo: string;
      request: Omit<PullRequestRequest, 'title' | 'body'>;
      order: OrderIssue;
      reports: readonly StepReport[];
      isCommit: IsCommit;
    };

/** Where the action pushes from and opens into, or why it cannot run. */
type Plan =
  | { kind: 'run'; repository: PullRequestRepository; revision: string }
  | { kind: 'fail'; reason: string }
  /** The secret scan stopped the push: the batch waits on a human (ADR 0079). */
  | { kind: 'blocked'; summary: string };

/** The findings the blocked summary names; it counts the rest. */
const NAMED_FINDINGS = 3;

// Each commit, place and kind: never the matched text, nor findSecrets' excerpt of it. The place
// comes last, so a file named `token` never reads as an assignment the status comment leaves out.
const refusal = (batchId: string, findings: readonly ScanFinding[]): string => {
  const named = findings
    .slice(0, NAMED_FINDINGS)
    .map(({ commit, place, kind }) => `commit ${commit}, ${kind} in ${place}`);
  const more = findings.length - named.length;
  return `the push of batch ${batchId} stopped before anything left the machine: its commits hold what looks like a secret, or what the scan cannot read (ADR 0079): ${[
    ...named,
    ...(more > 0 ? [`and ${more} more`] : []),
  ].join('; ')}`;
};

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
      const recorded = state.effects.get(effectKey.encode(pushKey(batchId)));
      const pushed = recorded === undefined ? undefined : PushResult.safeParse(recorded);
      if (pushed?.success === false) {
        return {
          kind: 'fail',
          reason: `the ledger holds a push of batch ${batchId} that is not one the engine records`,
        };
      }
      const why = pushed?.data;
      // Recorded for good: a rewind after it does not scan again (ADR 0079).
      if (why?.refused !== undefined) {
        return { kind: 'blocked', summary: refusal(batchId, why.refused) };
      }
      if (why?.empty === true) {
        return {
          kind: 'fail',
          reason: `batch ${batchId} has no commits beyond ${repository.base} to open a pull request with`,
        };
      }
      // The ledger keeps the push of the batch's life: a rewind after it cannot reach its branch.
      if (why !== undefined && why.from !== revision) {
        return {
          kind: 'fail',
          reason: `batch ${batchId} pushed ${why.from} for its pull request, and its task tree has moved to ${revision} since: updating an open bottle is not supported yet (ADR 0071)`,
        };
      }
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
        const { push, revision, base, branch } = effect;
        // The commit to push, and whether the base holds all of it: a pull request with no commits,
        // which the code host refuses, is recorded as nothing to push instead.
        const resolve = async (signal?: AbortSignal) => {
          const commit = await push.commit(revision, signal);
          const from = await push.commit(base, signal);
          // Every commit of the task tree is in the base already, also when the base moved past it.
          const empty = await push.isAncestor(commit, from, signal);
          const result: PushResult = {
            branch,
            commit,
            from: revision,
            ...(empty ? { empty } : {}),
          };
          return { result, base: from };
        };
        return {
          // Pushed by a run before that was killed before it recorded the push.
          find: async (_key, signal) => {
            const { result } = await resolve(signal);
            if (result.empty === true) return { result };
            const tip = await push.remoteTip(branch, signal);
            return tip === result.commit ? { result } : undefined;
          },
          // Nothing leaves the machine before the scan of every commit it would carry (ADR 0079).
          apply: async (_key, signal): Promise<PushResult> => {
            const { result, base: start } = await resolve(signal);
            if (result.empty === true) return result;
            const found = await push.secretScan(start, result.commit, signal);
            if (found.length > 0) return { ...result, refused: found.slice(0, MAX_REFUSED) };
            await push.push(result.commit, branch, signal);
            return result;
          },
        };
      }
      case 'open': {
        const { repo, request, order, reports, isCommit } = effect;
        return {
          find: async (_key, signal) => {
            const url = await host.find(repo, request.head, signal);
            return url === undefined ? undefined : { result: pullRequestUrl(url) };
          },
          apply: async (_key, signal) => {
            const text = pullRequestText({
              title: await orderTitle(order, signal),
              closes: { repo: order.repo ?? brewery, issue: order.issue },
              reports,
              isCommit,
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
      if (planned.kind !== 'run' || batch === undefined) return [];
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
        base: `origin/${repository.base}`,
        branch,
      });
      effects.set(effectKey.encode(pullRequestKey(batchId)), {
        kind: 'open',
        repo,
        request: { head: branch, base: repository.base },
        order,
        reports: stepReports(batch),
        isCommit: knownCommits(state, batchId),
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
      if (planned.kind === 'blocked') {
        return { kind: 'blocked', blockerKind: 'environment', summary: planned.summary };
      }
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
