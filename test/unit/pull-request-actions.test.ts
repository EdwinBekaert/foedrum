// The openPullRequest action's effects (ADR 0071): the push of the task tree to the bottle branch,
// then the pull request, each found by being there before it is applied, through a fake push and a
// fake code host; and how the attempt ends.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { effectKey } from '../../src/engine/effect-key.ts';
import { fold, type State } from '../../src/engine/fold.ts';
import { withoutSecrets } from '../../src/engine/out-doc-text.ts';
import { knownCommits } from '../../src/engine/pull-request.ts';
import {
  type BranchPush,
  type PullRequestHost,
  type PullRequestRequest,
  pullRequestActions,
} from '../../src/engine/pull-request-actions.ts';
import type { Event } from '../../src/schemas/events.ts';
import type { ScanFinding } from '../../src/schemas/store.ts';

const tip = 'c'.repeat(40);
const other = 'd'.repeat(40);
const url = 'https://github.com/acme/api/pull/9';
const branch = 'foedrum/acme.brewery/12-1/acme.api';
const action = { batchId: '12-1', stepId: 'open-pull-request', attempt: 1 };
const push = effectKey.encode({ batchId: '12-1', effect: 'push' });
const open = effectKey.encode({ batchId: '12-1', effect: 'pull_request' });

const base = 'b'.repeat(40);
const from = 'refs/heads/foedrum/12-1/implement/1';

/**
 * A clone whose revisions name `tip`, but for `origin/main` at `main`, and a remote with the
 * branches it was pushed, whose main is at `fetched`.
 */
const fakePush = (
  remote: Record<string, string> = {},
  main = base,
  behind: string[] = [],
  found: ScanFinding[] = [],
  fetched = main,
) => {
  const asked: string[] = [];
  const pushes: string[] = [];
  const scans: string[] = [];
  const target: BranchPush = {
    commit: async (revision) => {
      asked.push(revision);
      return revision === 'origin/main' ? main : tip;
    },
    baseTip: async (name) => {
      asked.push(`fetch ${name}`);
      return fetched;
    },
    // A commit is an ancestor of itself, and of the remote's base when it moved past it.
    isAncestor: async (commit, of) => commit === of || (of === fetched && behind.includes(commit)),
    remoteTip: async (name) => remote[name],
    push: async (commit, name) => {
      pushes.push(`${commit} ${name}`);
      remote[name] = commit;
    },
    secretScan: async (from, to) => {
      scans.push(`${from}..${to}`);
      return found;
    },
  };
  return { target, asked, pushes, remote, scans };
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
    main?: string;
    behind?: string[];
    opened?: Record<string, string>;
    answer?: string;
    found?: ScanFinding[];
    fetched?: string;
  } = {},
) => {
  const pushed = fakePush(
    options.remote,
    options.main,
    options.behind,
    options.found,
    options.fetched,
  );
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
    assert.deepEqual(await actions.target.apply(push), { branch, commit: tip, from });
    assert.deepEqual(asked, [from, 'fetch main']);
    assert.deepEqual(pushes, [`${tip} ${branch}`]);
  });

  it('finds the push when the remote branch is at that tip already, and not otherwise', async () => {
    const at = actionsWith({ remote: { [branch]: tip } });
    keysOf(brewing(), at.actions);
    assert.deepEqual(await at.actions.target.find(push), {
      result: { branch, commit: tip, from },
    });
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

  it('opens it as a draft with the recipe and the brew log when no step tasted it (ADR 0167)', async () => {
    const { actions, requests } = actionsWith();
    keysOf(brewing(), actions);
    await actions.target.apply(open);
    const request = requests[0]?.request;
    assert.equal(request?.draft, true);
    assert.match(
      request?.body ?? '',
      /\nBrewed by Foedrum from acme\/brewery#12 with the recipe ale\.\n/,
    );
    assert.match(request?.body ?? '', /\n\| implement #1 \| succeeded \|\n/);
  });

  it('opens it ready when every Taster approved and how it works is written (ADR 0167)', async () => {
    const { actions, requests } = actionsWith();
    const written = brewed.map((event) =>
      event.type === 'step.finished'
        ? {
            ...event,
            outcome: {
              kind: 'succeeded' as const,
              output: {
                status: 'done',
                summary: 'Added --json',
                assumptions: [],
                howItWorks: 'This touches the CLI.',
              },
            },
          }
        : event,
    );
    const tasted: Event[] = [
      {
        type: 'step.scheduled',
        batchId: '12-1',
        stepId: 'taste',
        attempt: 1,
        deadlineAt: '2026-10-15T13:30:00.000Z',
      },
      { type: 'step.started', batchId: '12-1', stepId: 'taste', attempt: 1 },
      {
        type: 'step.finished',
        batchId: '12-1',
        stepId: 'taste',
        attempt: 1,
        outcome: {
          kind: 'succeeded',
          output: {
            status: 'done',
            summary: 'No defects',
            assumptions: [],
            verdict: 'approve',
            findings: [],
          },
        },
      },
    ];
    keysOf(fold([ordered({ issue: 12 }), ...written, ...tasted, ...opening]), actions);
    await actions.target.apply(open);
    assert.equal(requests[0]?.request.draft, false);
  });

  it("leaves out report text that looks like a secret, but not a commit the batch's state records (#235)", async () => {
    const { actions, requests } = actionsWith();
    const token = ['ghp', 'A1b2'.repeat(9)].join('_');
    const reported = brewed.map((event) =>
      event.type === 'step.finished'
        ? {
            ...event,
            outcome: {
              kind: 'succeeded' as const,
              output: { status: 'done', summary: `Started at ${other}`, assumptions: [token] },
            },
          }
        : event,
    );
    keysOf(fold([ordered({ issue: 12 }), ...reported, ...opening]), actions);
    await actions.target.apply(open);
    const body = requests[0]?.request.body ?? '';
    assert.match(body, new RegExp(`implement: Started at ${other}`));
    assert.match(body, /assumed: \[left out: a text of step implement that looks like a secret\]/);
    assert.doesNotMatch(body, /ghp|A1b2/);
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

  it('refuses a pull request it found whose URL is not one without credentials', async () => {
    for (const answer of [
      'http://github.com/acme/api/pull/9',
      'https://x:y@github.com/acme/api/pull/9',
    ]) {
      const { actions } = actionsWith({ opened: { [branch]: answer } });
      keysOf(brewing(), actions);
      await assert.rejects(actions.target.find(open), /not a pull request URL/);
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
      applied(push, { branch, commit: tip, from }),
      applied(open, url),
    ]);
    assert.deepEqual(actions.ending(state, action), {
      kind: 'succeeded',
      output: { pullRequest: url },
    });
  });

  it('fails retryably while the ledger has no pull request yet', () => {
    const { actions } = actionsWith();
    const state = fold([
      ordered({ issue: 12 }),
      ...brewed,
      ...opening,
      applied(push, { branch, commit: tip, from }),
    ]);
    assert.deepEqual(actions.ending(state, action), {
      kind: 'failed',
      retryable: true,
      reason: 'the ledger has no pull request of batch 12-1',
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

describe('pullRequestActions: a push that cannot carry the batch (review of #198)', () => {
  it('records a task tree at the base as nothing to push, pushes nothing, and fails for good', async () => {
    const { actions, pushes } = actionsWith({ main: tip });
    keysOf(brewing(), actions);
    const nothing = { branch, commit: tip, from, empty: true };
    assert.deepEqual(await actions.target.find(push), { result: nothing });
    assert.deepEqual(await actions.target.apply(push), nothing);
    assert.deepEqual(pushes, []);
    const state = fold([ordered({ issue: 12 }), ...brewed, ...opening, applied(push, nothing)]);
    assert.deepEqual(actions.due(state, action), []);
    assert.deepEqual(actions.ending(state, action), {
      kind: 'failed',
      retryable: false,
      reason: 'batch 12-1 has no commits beyond main to open a pull request with',
    });
  });

  it('fails for good when the task tree moved after the push, as a rewind moves it', () => {
    const { actions } = actionsWith();
    const earlier = 'refs/heads/foedrum/12-1/plan/1';
    const state = fold([
      ordered({ issue: 12 }),
      ...brewed,
      ...opening,
      applied(push, { branch, commit: other, from: earlier }),
    ]);
    assert.deepEqual(actions.due(state, action), []);
    assert.deepEqual(actions.ending(state, action), {
      kind: 'failed',
      retryable: false,
      reason: `batch 12-1 pushed ${earlier} for its pull request, and its task tree has moved to ${from} since: updating an open bottle is not supported yet (ADR 0071)`,
    });
  });
});

describe('pullRequestActions: the recorded push is read by its schema (review of #198)', () => {
  it('fails for good on a recorded push that is not one the engine records', () => {
    for (const result of [{ from: 5 }, { branch, commit: 'HEAD', from }, 'pushed']) {
      const { actions } = actionsWith();
      const state = fold([ordered({ issue: 12 }), ...brewed, ...opening, applied(push, result)]);
      assert.deepEqual(actions.due(state, action), []);
      assert.deepEqual(actions.ending(state, action), {
        kind: 'failed',
        retryable: false,
        reason: 'the ledger holds a push of batch 12-1 that is not one the engine records',
      });
    }
  });
});

describe('pullRequestActions: a task tree the base has moved past (review of #198)', () => {
  it('records it as nothing to push: the base already holds every commit of it', async () => {
    const { actions, pushes } = actionsWith({ behind: [tip] });
    keysOf(brewing(), actions);
    const nothing = { branch, commit: tip, from, empty: true };
    assert.deepEqual(await actions.target.apply(push), nothing);
    assert.deepEqual(await actions.target.find(push), { result: nothing });
    assert.deepEqual(pushes, []);
  });
});

describe('pullRequestActions: the base as the remote has it now (ADR 0090)', () => {
  const moved = 'e'.repeat(40);

  it("records a task tree the remote's base holds as nothing to push, while the clone's origin/main is behind", async () => {
    const { actions, pushes, scans } = actionsWith({ main: base, fetched: moved, behind: [tip] });
    keysOf(brewing(), actions);
    const nothing = { branch, commit: tip, from, empty: true };
    assert.deepEqual(await actions.target.find(push), { result: nothing });
    assert.deepEqual(await actions.target.apply(push), nothing);
    assert.deepEqual(pushes, []);
    assert.deepEqual(scans, []);
  });

  it("scans from the base the empty check read, not from the clone's origin/main", async () => {
    const { actions, asked, pushes, scans } = actionsWith({ main: base, fetched: moved });
    keysOf(brewing(), actions);
    assert.deepEqual(await actions.target.apply(push), { branch, commit: tip, from });
    assert.deepEqual(scans, [`${moved}..${tip}`]);
    assert.deepEqual(pushes, [`${tip} ${branch}`]);
    assert.equal(asked.includes('fetch main'), true);
    assert.equal(asked.includes('origin/main'), false);
  });
});

describe('pullRequestActions: the secret scan before the push (ADR 0079)', () => {
  const found: ScanFinding[] = [
    { commit: tip, place: 'message', kind: 'GitHub token' },
    { commit: other, place: 'notes/aws.txt', kind: 'AWS access key id' },
  ];
  const summary =
    'the push of batch 12-1 stopped before anything left the machine: its commits hold what looks like a secret, or what the scan cannot read (ADR 0079): ' +
    `commit ${tip}, GitHub token in message; commit ${other}, AWS access key id in notes/aws.txt`;

  it('scans every commit from the base to the tip, then pushes a clean task tree as before', async () => {
    const { actions, pushes, scans } = actionsWith();
    keysOf(brewing(), actions);
    assert.deepEqual(await actions.target.apply(push), { branch, commit: tip, from });
    assert.deepEqual(scans, [`${base}..${tip}`]);
    assert.deepEqual(pushes, [`${tip} ${branch}`]);
  });

  it('records what the scan found instead of pushing', async () => {
    const { actions, pushes } = actionsWith({ found });
    keysOf(brewing(), actions);
    assert.deepEqual(await actions.target.apply(push), {
      branch,
      commit: tip,
      from,
      refused: found,
    });
    assert.deepEqual(pushes, []);
  });

  it('scans nothing when there is nothing to push', async () => {
    const { actions, scans } = actionsWith({ main: tip, found });
    keysOf(brewing(), actions);
    assert.equal(((await actions.target.apply(push)) as { empty?: true }).empty, true);
    assert.deepEqual(scans, []);
  });

  it('records at most 50 findings', async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      commit: tip,
      place: `f${i}.txt`,
      kind: 'GitHub token',
    }));
    const { actions } = actionsWith({ found: many });
    keysOf(brewing(), actions);
    const result = (await actions.target.apply(push)) as { refused: ScanFinding[] };
    assert.deepEqual(result.refused, many.slice(0, 50));
  });

  it('blocks the attempt on its environment for good, naming each commit, place and kind, and opens no pull request', () => {
    const { actions } = actionsWith();
    const state = fold([
      ordered({ issue: 12 }),
      ...brewed,
      ...opening,
      applied(push, { branch, commit: tip, from, refused: found }),
    ]);
    assert.deepEqual(actions.due(state, action), []);
    assert.deepEqual(actions.ending(state, action), {
      kind: 'blocked',
      blockerKind: 'environment',
      summary,
    });
  });

  it('names the first three findings and counts the rest', () => {
    const { actions } = actionsWith();
    const five = ['a', 'b', 'c', 'd', 'e'].map((name) => ({
      commit: tip,
      place: `${name}.txt`,
      kind: 'GitHub token',
    }));
    const state = fold([
      ordered({ issue: 12 }),
      ...brewed,
      ...opening,
      applied(push, { branch, commit: tip, from, refused: five }),
    ]);
    const ending = actions.ending(state, action);
    assert.equal(ending.kind, 'blocked');
    assert.match(
      ending.kind === 'blocked' ? ending.summary : '',
      new RegExp(`commit ${tip}, GitHub token in c.txt; and 2 more$`),
    );
  });

  // Review of #253: `token: GitHub token` reads as a credential assignment.
  it('names each place so that a file named like a credential reads as no secret itself', () => {
    const { actions } = actionsWith();
    const named = ['token', 'header secret', 'password'].map((place) => ({
      commit: tip,
      place,
      kind: 'GitHub token',
    }));
    const state = fold([
      ordered({ issue: 12 }),
      ...brewed,
      ...opening,
      applied(push, { branch, commit: tip, from, refused: named }),
    ]);
    const ending = actions.ending(state, action);
    const stopped = ending.kind === 'blocked' ? ending.summary : '';
    assert.equal(
      withoutSecrets(stopped, 'open-pull-request', knownCommits(state, '12-1')),
      stopped,
    );
  });
});
