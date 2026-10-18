// The openPullRequest action's effects (ADR 0071): the push of the task tree to the bottle branch,
// then the pull request, each found by being there before it is applied, through a fake push and a
// fake code host; and how the attempt ends.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { effectKey } from '../../src/engine/effect-key.ts';
import { fold, type State } from '../../src/engine/fold.ts';
import {
  type BranchPush,
  type PullRequestHost,
  type PullRequestRequest,
  pullRequestActions,
} from '../../src/engine/pull-request-actions.ts';
import type { Event } from '../../src/schemas/events.ts';

const tip = 'c'.repeat(40);
const other = 'd'.repeat(40);
const url = 'https://github.com/acme/api/pull/9';
const branch = 'foedrum/acme.brewery/12-1/acme.api';
const action = { batchId: '12-1', stepId: 'open-pull-request', attempt: 1 };
const push = effectKey.encode({ batchId: '12-1', effect: 'push' });
const open = effectKey.encode({ batchId: '12-1', effect: 'pull_request' });

/** A clone whose revisions name `tip`, and a remote with the branches it was pushed. */
const fakePush = (remote: Record<string, string> = {}) => {
  const asked: string[] = [];
  const pushes: string[] = [];
  const target: BranchPush = {
    commit: async (revision) => {
      asked.push(revision);
      return tip;
    },
    remoteTip: async (name) => remote[name],
    push: async (commit, name) => {
      pushes.push(`${commit} ${name}`);
      remote[name] = commit;
    },
  };
  return { target, asked, pushes, remote };
};

/** A code host with the pull requests the Brewery opened, by head branch. */
const fakeHost = (opened: Record<string, string> = {}, answer = url) => {
  const requests: { repo: string; request: PullRequestRequest }[] = [];
  const host: PullRequestHost = {
    find: async (repo, head) => (repo === 'acme/api' ? opened[head] : undefined),
    open: async (repo, request) => {
      requests.push({ repo, request });
      opened[request.head] = answer;
      return answer;
    },
  };
  return { host, requests };
};

const ordered = (order: { issue: number; repo?: string }): Event => ({
  type: 'batch.ordered',
  batchId: '12-1',
  order,
  routeBy: '2026-12-31T00:00:00.000Z',
});
const brewed: Event[] = [
  { type: 'batch.recipe_chosen', batchId: '12-1', recipe: 'ale', reason: 'label', source: 'label' },
  {
    type: 'step.scheduled',
    batchId: '12-1',
    stepId: 'implement',
    attempt: 1,
    deadlineAt: '2026-10-15T13:00:00.000Z',
  },
  {
    type: 'step.started',
    batchId: '12-1',
    stepId: 'implement',
    attempt: 1,
    worktree: {
      repo: 'acme/api',
      path: '/work/acme.api/12-1/implement/1',
      branch: 'foedrum/12-1/implement/1',
      commit: other,
    },
  },
  {
    type: 'step.finished',
    batchId: '12-1',
    stepId: 'implement',
    attempt: 1,
    outcome: {
      kind: 'succeeded',
      output: { status: 'done', summary: 'Added --json', assumptions: [] },
    },
  },
];
const opening: Event[] = [
  {
    type: 'step.scheduled',
    batchId: '12-1',
    stepId: 'open-pull-request',
    attempt: 1,
    deadlineAt: '2026-10-15T14:00:00.000Z',
  },
  { type: 'step.started', batchId: '12-1', stepId: 'open-pull-request', attempt: 1 },
];
const applied = (key: string, result: unknown): Event => ({ type: 'effect.applied', key, result });

const actionsWith = (
  options: {
    remote?: Record<string, string>;
    opened?: Record<string, string>;
    answer?: string;
  } = {},
) => {
  const pushed = fakePush(options.remote);
  const code = fakeHost(options.opened, options.answer);
  const titles: unknown[] = [];
  const actions = pullRequestActions({
    brewery: 'acme/brewery',
    repositories: [{ repo: 'acme/api', base: 'main', push: pushed.target }],
    host: code.host,
    orderTitle: async (order) => {
      titles.push(order);
      return 'Add a --json flag';
    },
  });
  return { actions, ...pushed, ...code, titles };
};
const brewing = (order = { issue: 12 }): State => fold([ordered(order), ...brewed, ...opening]);
const keysOf = (state: State, actions: ReturnType<typeof actionsWith>['actions']) =>
  actions.due(state, action).map((key) => effectKey.encode(key));

describe('pullRequestActions: what the action calls for', () => {
  it('pushes, then opens the pull request, both keyed by the batch', () => {
    const { actions } = actionsWith();
    assert.deepEqual(keysOf(brewing(), actions), [push, open]);
  });

  it('calls for nothing when no attempt that succeeded made a worktree: there is nothing to push', () => {
    const { actions } = actionsWith();
    const state = fold([ordered({ issue: 12 }), brewed[0] as Event, ...opening]);
    assert.deepEqual(actions.due(state, action), []);
  });
});

describe('pullRequestActions: the push', () => {
  it('pushes the tip of the task tree, read in the clone, to the bottle branch', async () => {
    const { actions, asked, pushes } = actionsWith();
    keysOf(brewing(), actions);
    assert.deepEqual(await actions.target.apply(push), { branch, commit: tip });
    assert.deepEqual(asked, ['refs/heads/foedrum/12-1/implement/1']);
    assert.deepEqual(pushes, [`${tip} ${branch}`]);
  });

  it('finds the push when the remote branch is at that tip already, and not otherwise', async () => {
    const at = actionsWith({ remote: { [branch]: tip } });
    keysOf(brewing(), at.actions);
    assert.deepEqual(await at.actions.target.find(push), { result: { branch, commit: tip } });
    const elsewhere = actionsWith({ remote: { [branch]: other } });
    keysOf(brewing(), elsewhere.actions);
    assert.equal(await elsewhere.actions.target.find(push), undefined);
    const none = actionsWith();
    keysOf(brewing(), none.actions);
    assert.equal(await none.actions.target.find(push), undefined);
  });
});

describe('pullRequestActions: the pull request', () => {
  it("opens it from the bottle branch into the base, with the order's title and the reports", async () => {
    const { actions, requests, titles } = actionsWith();
    keysOf(brewing(), actions);
    assert.equal(await actions.target.apply(open), url);
    assert.deepEqual(titles, [{ issue: 12 }]);
    assert.equal(requests.length, 1);
    const [{ repo, request } = { repo: '', request: undefined }] = requests;
    assert.equal(repo, 'acme/api');
    assert.equal(request?.head, branch);
    assert.equal(request?.base, 'main');
    assert.equal(request?.title, 'Add a --json flag');
    assert.match(request?.body ?? '', /implement: Added --json/);
    assert.match(request?.body ?? '', /\nCloses acme\/brewery#12$/);
  });

  it('closes a claimed issue in its own repository, reading its title there', async () => {
    const { actions, requests, titles } = actionsWith();
    keysOf(brewing({ issue: 7, repo: 'acme/api' } as { issue: number }), actions);
    await actions.target.apply(open);
    assert.deepEqual(titles, [{ issue: 7, repo: 'acme/api' }]);
    assert.match(requests[0]?.request.body ?? '', /\nCloses acme\/api#7$/);
  });

  it('finds the pull request the Brewery opened from the bottle branch', async () => {
    const { actions, requests } = actionsWith({ opened: { [branch]: url } });
    keysOf(brewing(), actions);
    assert.deepEqual(await actions.target.find(open), { result: url });
    assert.equal(requests.length, 0);
  });

  it('refuses an answer that is not a pull request URL without credentials', async () => {
    for (const answer of [
      'http://github.com/acme/api/pull/9',
      'https://x:y@github.com/acme/api/pull/9',
    ]) {
      const { actions } = actionsWith({ answer });
      keysOf(brewing(), actions);
      await assert.rejects(actions.target.apply(open), /not a pull request URL/);
    }
  });

  it('refuses a key it did not call for', async () => {
    const { actions } = actionsWith();
    await assert.rejects(
      actions.target.apply(open),
      /No pull request effect \["12-1","pull_request"\] is due/,
    );
  });
});

describe('pullRequestActions: how the attempt ends', () => {
  it('succeeds with the pull request the ledger recorded', () => {
    const { actions } = actionsWith();
    const state = fold([
      ordered({ issue: 12 }),
      ...brewed,
      ...opening,
      applied(push, { branch, commit: tip }),
      applied(open, url),
    ]);
    assert.deepEqual(actions.ending(state, action), {
      kind: 'succeeded',
      output: { pullRequest: url },
    });
  });

  it('fails for good when there was nothing to push', () => {
    const { actions } = actionsWith();
    const state = fold([ordered({ issue: 12 }), brewed[0] as Event, ...opening]);
    assert.deepEqual(actions.ending(state, action), {
      kind: 'failed',
      retryable: false,
      reason:
        'batch 12-1 has no commits to open a pull request with: no attempt that succeeded made a worktree',
    });
  });

  it('fails for good when the batch writes in a repository the Brewery does not list', () => {
    const { actions } = actionsWith();
    const state = brewing({ issue: 7, repo: 'acme/web' } as { issue: number });
    assert.deepEqual(actions.due(state, action), []);
    assert.deepEqual(actions.ending(state, action), {
      kind: 'failed',
      retryable: false,
      reason: 'batch 12-1 writes in acme/web, which the Brewery does not list',
    });
  });
});
