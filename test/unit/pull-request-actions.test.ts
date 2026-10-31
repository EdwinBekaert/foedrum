// The openPullRequest action's effects (ADR 0071): the push of the task tree to the bottle branch,
// then the pull request, each found by being there before it is applied, through a fake push and a
// fake code host; and how the attempt ends.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sensitivePathsOf, TEST_MAP_PATH } from '../../src/checks/test-map.ts';
import { baseMergeKey } from '../../src/engine/base-merge.ts';
import { effectKey } from '../../src/engine/effect-key.ts';
import { fold, type State } from '../../src/engine/fold.ts';
import { withoutSecrets } from '../../src/engine/out-doc-text.ts';
import { knownCommits } from '../../src/engine/pull-request.ts';
import {
  type BranchPush,
  type PullRequestHost,
  type PullRequestRepository,
  type PullRequestRequest,
  pullRequestActions,
} from '../../src/engine/pull-request-actions.ts';
import { sensitiveLine } from '../../src/engine/status-comment.ts';
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
  touched: string[] = [],
  commits: Record<string, string> = {},
) => {
  const asked: string[] = [];
  const pushes: string[] = [];
  const scans: string[] = [];
  const diffs: string[] = [];
  const target: BranchPush = {
    commit: async (revision) => {
      asked.push(revision);
      return commits[revision] ?? (revision === 'origin/main' ? main : tip);
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
    touchedFiles: async (since, to) => {
      diffs.push(`${since}..${to}`);
      return touched;
    },
  };
  return { target, asked, pushes, remote, scans, diffs };
};

/** A code host with the pull requests the Brewery opened, by head branch, and their bodies by URL. */
const fakeHost = (
  opened: Record<string, string> = {},
  answer = url,
  bodies: Record<string, string> = {},
) => {
  const requests: { repo: string; request: PullRequestRequest }[] = [];
  const updates: { url: string; body: string }[] = [];
  const host: PullRequestHost = {
    find: async (repo, head) => (repo === 'acme/api' ? opened[head] : undefined),
    open: async (repo, request) => {
      requests.push({ repo, request });
      opened[request.head] = answer;
      bodies[answer] = request.body;
      return answer;
    },
    body: async (at) => bodies[at] ?? assert.fail(`no pull request ${at}`),
    update: async (at, body) => {
      updates.push({ url: at, body });
      bodies[at] = body;
    },
  };
  return { host, requests, updates, bodies };
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
    touched?: string[];
    sensitivePaths?: string[];
    unmeasured?: PullRequestRepository['unmeasured'];
    commits?: Record<string, string>;
    bodies?: Record<string, string>;
  } = {},
) => {
  const pushed = fakePush(
    options.remote,
    options.main,
    options.behind,
    options.found,
    options.fetched,
    options.touched,
    options.commits,
  );
  const code = fakeHost(options.opened, options.answer, options.bodies);
  const titles: unknown[] = [];
  const actions = pullRequestActions({
    brewery: 'acme/brewery',
    repositories: [
      {
        repo: 'acme/api',
        base: 'main',
        push: pushed.target,
        ...(options.sensitivePaths === undefined ? {} : { sensitivePaths: options.sensitivePaths }),
        ...(options.unmeasured === undefined ? {} : { unmeasured: options.unmeasured }),
      },
    ],
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
    // Its last line is the marker of the open's key, after Closes (ADR 0227).
    assert.match(
      request?.body ?? '',
      /\nCloses acme\/brewery#12\n\n<!-- foedrum:\["12-1","pull_request"\] sha256:[0-9a-f]{16} -->$/,
    );
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
    assert.match(request?.body ?? '', /\n\| `implement #1` \| succeeded \|\n/);
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
    assert.match(requests[0]?.request.body ?? '', /\nCloses acme\/api#7\n\n<!-- foedrum:/);
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

  it('still scans from the base, not from the start of the attempt whose own scan passed, and refuses what it finds (ADR 0187)', async () => {
    const { actions, pushes, scans } = actionsWith({ found });
    // implement#1's commits held a secret, and implement#2, its retry, passed its own scan.
    const [chosen, scheduled, started, finished] = brewed as [Event, Event, Event, Event];
    const retry = { batchId: '12-1', stepId: 'implement', attempt: 2 };
    const state = fold([
      ordered({ issue: 12 }),
      chosen,
      scheduled,
      started,
      {
        type: 'step.finished',
        batchId: '12-1',
        stepId: 'implement',
        attempt: 1,
        outcome: {
          kind: 'failed',
          retryable: true,
          reason: `the attempt's commits hold what looks like a secret, or what the scan cannot read (ADR 0187): commit ${tip.slice(0, 12)}, GitHub token in message`,
          secrets: true,
        },
      },
      { type: 'step.scheduled', ...retry, deadlineAt: '2026-10-15T13:00:00.000Z', retry: true },
      {
        type: 'step.started',
        ...retry,
        worktree: {
          repo: 'acme/api',
          path: '/work/acme.api/12-1/implement/2',
          branch: 'foedrum/12-1/implement/2',
          commit: other,
        },
      },
      { ...(finished as Event & { type: 'step.finished' }), attempt: 2 },
      ...opening,
    ]);
    keysOf(state, actions);
    const result = await actions.target.apply(push);
    // The task tree is implement#2's, which started at `other`: its own scan read only what came
    // after it; the push reads every commit from the base.
    assert.deepEqual(scans, [`${base}..${tip}`]);
    assert.equal((result as { from?: string }).from, 'refs/heads/foedrum/12-1/implement/2');
    assert.deepEqual((result as { refused?: ScanFinding[] }).refused, found);
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

describe('pullRequestActions: the sensitive paths the change touches (ADR 0201)', () => {
  const sensitivePaths = ['.github/workflows/**', 'src/auth/**'];
  const touched = ['src/auth/login.ts', 'README.md', '.github/workflows/ci.yml'];
  const sensitive = { count: 2, files: ['src/auth/login.ts', '.github/workflows/ci.yml'] };

  it('records the files that match, as git named them, from where the change starts to the commit pushed', async () => {
    const { actions, diffs, pushes } = actionsWith({ sensitivePaths, touched });
    keysOf(brewing(), actions);
    assert.deepEqual(await actions.target.apply(push), { branch, commit: tip, from, sensitive });
    // The batch started at its first attempt's commit.
    assert.deepEqual(diffs, [`${other}..${tip}`]);
    assert.deepEqual(pushes, [`${tip} ${branch}`]);
  });

  it('lets a wildcard match a file or folder whose name starts with a dot (review of #523)', async () => {
    const { actions } = actionsWith({
      sensitivePaths: ['src/auth/**', '**/*.yml', 'config/*'],
      touched: [
        'src/auth/.env',
        '.github/workflows/ci.yml',
        'config/.npmrc',
        'src/authx.ts',
        'a.yaml',
      ],
    });
    keysOf(brewing(), actions);
    assert.deepEqual(await actions.target.apply(push), {
      branch,
      commit: tip,
      from,
      sensitive: {
        count: 3,
        files: ['src/auth/.env', '.github/workflows/ci.yml', 'config/.npmrc'],
      },
    });
  });

  it('matches a dot the glob writes only with a dot, also inside braces or a class, and keeps case (review of #523)', async () => {
    const { actions } = actionsWith({
      sensitivePaths: ['.github/workflows/**', '{.env,.npmrc}', '[.]secrets', 'src/auth/**'],
      touched: [
        'github/workflows/ci.yml',
        '.env',
        'env',
        '.npmrc',
        '.secrets',
        'src/Auth/login.ts',
        '.github/workflows/ci.yml',
      ],
    });
    keysOf(brewing(), actions);
    assert.deepEqual(await actions.target.apply(push), {
      branch,
      commit: tip,
      from,
      sensitive: {
        count: 4,
        files: ['.env', '.npmrc', '.secrets', '.github/workflows/ci.yml'],
      },
    });
  });

  it('records them on a push it finds too', async () => {
    const { actions } = actionsWith({ sensitivePaths, touched, remote: { [branch]: tip } });
    keysOf(brewing(), actions);
    assert.deepEqual(await actions.target.find(push), {
      result: { branch, commit: tip, from, sensitive },
    });
  });

  it('records nothing when the change touches none of them', async () => {
    const { actions, diffs } = actionsWith({ sensitivePaths, touched: ['README.md'] });
    keysOf(brewing(), actions);
    assert.deepEqual(await actions.target.apply(push), { branch, commit: tip, from });
    assert.equal(diffs.length, 1);
  });

  it('reads no diff when the repository names no sensitive paths', async () => {
    for (const paths of [undefined, []]) {
      const { actions, diffs } = actionsWith({
        touched,
        ...(paths === undefined ? {} : { sensitivePaths: paths }),
      });
      keysOf(brewing(), actions);
      assert.deepEqual(await actions.target.apply(push), { branch, commit: tip, from });
      assert.deepEqual(diffs, []);
    }
  });

  it('reads no diff for a push the scan refused, nor for nothing to push', async () => {
    const found: ScanFinding[] = [{ commit: tip, place: 'message', kind: 'GitHub token' }];
    const refused = actionsWith({ sensitivePaths, touched, found });
    keysOf(brewing(), refused.actions);
    assert.deepEqual(await refused.actions.target.apply(push), {
      branch,
      commit: tip,
      from,
      refused: found,
    });
    assert.deepEqual(refused.diffs, []);
    const empty = actionsWith({ sensitivePaths, touched, behind: [tip] });
    keysOf(brewing(), empty.actions);
    assert.deepEqual(await empty.actions.target.apply(push), {
      branch,
      commit: tip,
      from,
      empty: true,
    });
    assert.deepEqual(empty.diffs, []);
  });

  it('keeps the first 50 files and counts them all', async () => {
    const many = Array.from({ length: 60 }, (_, n) => `src/auth/f${n}.ts`);
    const { actions } = actionsWith({ sensitivePaths, touched: many });
    keysOf(brewing(), actions);
    assert.deepEqual(await actions.target.apply(push), {
      branch,
      commit: tip,
      from,
      sensitive: { count: 60, files: many.slice(0, 50) },
    });
  });

  it('reads no diff for a batch with no recorded start', async () => {
    const { actions, diffs } = actionsWith({ sensitivePaths, touched });
    const state = brewing();
    const batch = state.batches.get('12-1');
    assert.ok(batch);
    const unstarted: State = { ...state, batches: new Map([['12-1', { ...batch, starts: {} }]]) };
    keysOf(unstarted, actions);
    assert.deepEqual(await actions.target.apply(push), { branch, commit: tip, from });
    assert.deepEqual(diffs, []);
  });
});

describe('pullRequestActions: where the sensitive-path diff starts, and when it fails (review of #523)', () => {
  const sensitivePaths = ['src/auth/**'];
  const touched = ['src/auth/login.ts'];

  it('diffs from the base the batch merged, not from where it started (ADR 0164)', async () => {
    const merged = 'e'.repeat(40);
    const mergeKey = effectKey.encode(
      baseMergeKey({ batchId: '12-1', stepId: 'implement', attempt: 1 }),
    );
    const state = fold([
      ordered({ issue: 12 }),
      ...brewed,
      ...opening,
      applied(mergeKey, { base: merged, merged: 'f'.repeat(40) }),
    ]);
    const { actions, diffs } = actionsWith({ sensitivePaths, touched });
    keysOf(state, actions);
    await actions.target.apply(push);
    assert.deepEqual(diffs, [`${merged}..${tip}`]);
  });

  it('finds the start of a repository the Brewery names in another case', async () => {
    const pushed = fakePush({}, base, [], [], base, touched);
    const actions = pullRequestActions({
      brewery: 'acme/brewery',
      repositories: [{ repo: 'Acme/API', base: 'main', push: pushed.target, sensitivePaths }],
      host: fakeHost().host,
      orderTitle: async () => 'Add a --json flag',
    });
    keysOf(brewing(), actions);
    const result = await actions.target.apply(push);
    assert.deepEqual(pushed.diffs, [`${other}..${tip}`]);
    assert.deepEqual((result as { sensitive?: unknown }).sensitive, {
      count: 1,
      files: touched,
    });
  });

  it('fails the push effect, pushing nothing, when the files cannot be read', async () => {
    const pushed = fakePush();
    const actions = pullRequestActions({
      brewery: 'acme/brewery',
      repositories: [
        {
          repo: 'acme/api',
          base: 'main',
          sensitivePaths,
          push: {
            ...pushed.target,
            touchedFiles: async () => {
              throw new Error('git diff failed: fatal: bad object');
            },
          },
        },
      ],
      host: fakeHost().host,
      orderTitle: async () => 'Add a --json flag',
    });
    keysOf(brewing(), actions);
    await assert.rejects(actions.target.apply(push), {
      message: 'git diff failed: fatal: bad object',
    });
    assert.deepEqual(pushed.pushes, []);
  });
});

describe('pullRequestActions: a later round pushes to the same pull request (ADR 0219)', () => {
  const fixed = 'e'.repeat(40);
  const person = 'f'.repeat(40);
  const push2 = effectKey.encode({ batchId: '12-1', effect: 'push.2' });
  const body2 = effectKey.encode({ batchId: '12-1', effect: 'body.2' });
  const from2 = 'refs/heads/foedrum/12-1/implement/2';
  const action2 = { ...action, attempt: 2 };
  const onTap: Event[] = [
    ordered({ issue: 12 }),
    ...brewed,
    ...opening,
    applied(push, { branch, commit: tip, from }),
    applied(open, url),
    {
      type: 'step.finished',
      batchId: '12-1',
      stepId: 'open-pull-request',
      attempt: 1,
      outcome: { kind: 'succeeded', output: { pullRequest: url } },
    },
    { type: 'batch.on_tap', batchId: '12-1', pullRequests: [url] },
  ];
  const round: Event[] = [
    {
      type: 'step.scheduled',
      batchId: '12-1',
      stepId: 'implement',
      attempt: 2,
      deadlineAt: '2026-10-15T15:00:00.000Z',
      route: { from: 'open-pull-request', why: 'pull_request', pullRequest: url, head: tip },
    },
    {
      type: 'step.started',
      batchId: '12-1',
      stepId: 'implement',
      attempt: 2,
      worktree: {
        repo: 'acme/api',
        path: '/work/acme.api/12-1/implement/2',
        branch: 'foedrum/12-1/implement/2',
        commit: tip,
      },
    },
    {
      type: 'step.finished',
      batchId: '12-1',
      stepId: 'implement',
      attempt: 2,
      outcome: {
        kind: 'succeeded',
        output: { status: 'done', summary: 'Fixed the test', assumptions: [] },
      },
    },
    {
      type: 'step.scheduled',
      batchId: '12-1',
      stepId: 'open-pull-request',
      attempt: 2,
      deadlineAt: '2026-10-15T16:00:00.000Z',
    },
    { type: 'step.started', batchId: '12-1', stepId: 'open-pull-request', attempt: 2 },
  ];
  const second = fold([...onTap, ...round]);
  const withRemote = (remote: Record<string, string>) =>
    actionsWith({ remote, commits: { [from2]: fixed } });

  it("pushes the round's task tree under the round's key, and opens nothing again", async () => {
    const { actions, pushes, requests } = withRemote({ [branch]: tip });
    assert.deepEqual(keysOf(second, actions), [push2, open]);
    assert.deepEqual(await actions.target.apply(push2), { branch, commit: fixed, from: from2 });
    assert.deepEqual(pushes, [`${fixed} ${branch}`]);
    assert.deepEqual(requests, []);
  });

  it('finds the push a kill left unrecorded, when the branch is at the new commit', async () => {
    const { actions } = withRemote({ [branch]: fixed });
    keysOf(second, actions);
    assert.deepEqual(await actions.target.find(push2), {
      result: { branch, commit: fixed, from: from2 },
    });
  });

  it('pushes nothing when someone else pushed to the branch since, and says so', async () => {
    const { actions, pushes } = withRemote({ [branch]: person });
    keysOf(second, actions);
    assert.equal(await actions.target.find(push2), undefined);
    assert.deepEqual(await actions.target.apply(push2), {
      branch,
      commit: fixed,
      from: from2,
      moved: person,
    });
    assert.deepEqual(pushes, []);
  });

  it('pushes nothing when the branch is gone, and says so', async () => {
    const { actions, pushes } = withRemote({});
    keysOf(second, actions);
    assert.deepEqual(await actions.target.apply(push2), {
      branch,
      commit: fixed,
      from: from2,
      gone: true,
    });
    assert.deepEqual(pushes, []);
  });

  it('ends with the same pull request once the round is pushed, or found moved', () => {
    const { actions } = withRemote({ [branch]: tip });
    for (const result of [
      { branch, commit: fixed, from: from2 },
      { branch, commit: fixed, from: from2, moved: person },
    ]) {
      const state = fold([...onTap, ...round, applied(push2, result)]);
      // A round that went renders the body again; one that found the branch moved does not.
      const body = 'moved' in result ? [] : [body2];
      assert.deepEqual(actions.due(state, action2).map(effectKey.encode), [push2, open, ...body]);
      assert.deepEqual(actions.ending(state, action2), {
        kind: 'succeeded',
        output: { pullRequest: url },
      });
    }
  });

  it('pushes nothing once the pull request ended during the fix, and ends with it', () => {
    const ended: Event = {
      type: 'pull_request.ended',
      batchId: '12-1',
      pullRequest: url,
      state: 'merged',
    };
    const { actions } = withRemote({ [branch]: tip });
    const state = fold([...onTap, round[0] as Event, ended, ...round.slice(1)]);
    assert.deepEqual(keysOf(state, actions), [open]);
    assert.deepEqual(actions.ending(state, action2), {
      kind: 'succeeded',
      output: { pullRequest: url },
    });
  });

  it("keeps the round's push it recorded before the pull request ended", () => {
    const ended: Event = {
      type: 'pull_request.ended',
      batchId: '12-1',
      pullRequest: url,
      state: 'merged',
    };
    const { actions } = withRemote({ [branch]: fixed });
    const recorded = applied(push2, { branch, commit: fixed, from: from2 });
    const state = fold([...onTap, ...round, recorded, ended]);
    // Nor a body: the pull request ended before it was rendered again (ADR 0227).
    assert.deepEqual(keysOf(state, actions), [push2, open]);
  });

  it('fails for good when the round before recorded no push', () => {
    const { actions } = withRemote({ [branch]: tip });
    const withoutFirst = onTap.filter(
      (event) => event.type !== 'effect.applied' || event.key !== push,
    );
    const state = fold([...withoutFirst, ...round]);
    assert.deepEqual(actions.due(state, action2), []);
    assert.deepEqual(actions.ending(state, action2), {
      kind: 'failed',
      retryable: false,
      reason: 'batch 12-1 has no push of round 1 of its pull request to push round 2 on',
    });
  });

  describe('the body is rendered again (ADR 0227)', () => {
    const went = { branch, commit: fixed, from: from2 };
    const pushedRound = fold([...onTap, ...round, applied(push2, went)]);
    const marker2 = /\n\n<!-- foedrum:\["12-1","body\.2"\] sha256:([0-9a-f]{16}) -->$/;
    /** The body the open wrote, as round 1 left it on the code host. */
    const openedBody = async (): Promise<string> => {
      const first = actionsWith();
      keysOf(brewing(), first.actions);
      await first.actions.target.apply(open);
      return first.bodies[url] ?? assert.fail('no body');
    };
    const onHost = (body: string) =>
      actionsWith({
        remote: { [branch]: fixed },
        commits: { [from2]: fixed },
        bodies: { [url]: body },
      });

    it("updates Foedrum's own body once, with the round's reports and the marker of body.2", async () => {
      const { actions, updates, requests } = onHost(await openedBody());
      assert.deepEqual(keysOf(pushedRound, actions), [push2, open, body2]);
      assert.equal(await actions.target.find(body2), undefined);
      const result = await actions.target.apply(body2);
      assert.equal(updates.length, 1);
      const [{ url: at, body } = { url: '', body: '' }] = updates;
      assert.equal(at, url);
      assert.match(body, /implement: Fixed the test/);
      assert.doesNotMatch(body, /implement: Added --json/);
      assert.match(body, /\| `implement #2` \| succeeded \|/);
      assert.match(body, /\nCloses acme\/brewery#12\n/);
      const [, digest] = marker2.exec(body) ?? assert.fail(body);
      assert.deepEqual(result, { digest });
      // Only the body: the title and the draft state stay as a person may have set them.
      assert.deepEqual(requests, []);
    });

    it('finds an update a kill left unrecorded by its marker, and updates nothing again', async () => {
      const bodies: Record<string, string> = { [url]: await openedBody() };
      const killed = actionsWith({
        remote: { [branch]: fixed },
        commits: { [from2]: fixed },
        bodies,
      });
      keysOf(pushedRound, killed.actions);
      const written = await killed.actions.target.apply(body2);
      const next = actionsWith({
        remote: { [branch]: fixed },
        commits: { [from2]: fixed },
        bodies,
      });
      keysOf(pushedRound, next.actions);
      assert.deepEqual(await next.actions.target.find(body2), { result: written });
      assert.deepEqual(next.updates, []);
    });

    it('reads \r\n line endings as no edit', async () => {
      const { actions, updates } = onHost((await openedBody()).replaceAll('\n', '\r\n'));
      keysOf(pushedRound, actions);
      assert.match(JSON.stringify(await actions.target.apply(body2)), /digest/);
      assert.equal(updates.length, 1);
    });

    it('leaves alone a body someone edited, or whose marker is not on its last line, and records it so', async () => {
      const opened = await openedBody();
      for (const body of [
        opened.replace('Added --json', 'Added --json, as a person put it'),
        `${opened}\n\n- [x] a box a bot ticked`,
      ]) {
        const { actions, updates } = onHost(body);
        keysOf(pushedRound, actions);
        assert.equal(await actions.target.find(body2), undefined);
        assert.deepEqual(await actions.target.apply(body2), { left: 'edited' });
        assert.deepEqual(updates, []);
      }
    });

    it('leaves alone a body with no marker, as every pull request opened before, and records it so', async () => {
      const opened = await openedBody();
      const { actions, updates } = onHost(opened.slice(0, opened.lastIndexOf('\n')).trimEnd());
      keysOf(pushedRound, actions);
      assert.deepEqual(await actions.target.apply(body2), { left: 'unmarked' });
      assert.deepEqual(updates, []);
    });

    it('renders nothing again for a round that pushed nothing', () => {
      const finding = { commit: fixed, place: 'message', kind: 'GitHub token' };
      for (const result of [
        { ...went, moved: person },
        { ...went, gone: true },
        { ...went, empty: true },
        { ...went, refused: [finding] },
      ]) {
        const { actions } = onHost('');
        const state = fold([...onTap, ...round, applied(push2, result)]);
        assert.ok(!keysOf(state, actions).includes(body2), JSON.stringify(result));
      }
    });
  });
});

describe('pullRequestActions: the test map is a sensitive path (ADR 0274)', () => {
  const touched = ['README.md', TEST_MAP_PATH];

  it("names a change to the test map in the status comment's sensitive-path line", async () => {
    // The repository names no sensitive path of its own.
    const { actions } = actionsWith({ sensitivePaths: sensitivePathsOf({}), touched });
    keysOf(brewing(), actions);
    const result = await actions.target.apply(push);
    const sensitive = { count: 1, files: [TEST_MAP_PATH] };
    assert.deepEqual(result, { branch, commit: tip, from, sensitive });
    assert.equal(sensitiveLine(sensitive), 'Touches sensitive paths: .foedrum/test-map.jsonc');
    // Beside the paths the repository names, and not where the Brewery keeps its map.
    assert.deepEqual(sensitivePathsOf({ sensitivePaths: ['src/auth/**'] }), [
      'src/auth/**',
      TEST_MAP_PATH,
    ]);
    assert.deepEqual(sensitivePathsOf({ sensitivePaths: ['src/auth/**'], testMap: 'brewery' }), [
      'src/auth/**',
    ]);
    assert.deepEqual(sensitivePathsOf({ testMap: 'brewery' }), []);
  });

  it('records the modules the batch adds with coverage none when its change touches the map', async () => {
    const asked: string[] = [];
    const unmeasured = async (since: string, commit: string) => {
      asked.push(`${since}..${commit}`);
      return ['engine', 'tools'];
    };
    const { actions } = actionsWith({ sensitivePaths: sensitivePathsOf({}), touched, unmeasured });
    keysOf(brewing(), actions);
    assert.deepEqual(await actions.target.apply(push), {
      branch,
      commit: tip,
      from,
      sensitive: { count: 1, files: [TEST_MAP_PATH], unmeasured: ['engine', 'tools'] },
    });
    assert.deepEqual(asked, [`${other}..${tip}`]);
    // A change that leaves the map alone reads no map.
    const untouched = actionsWith({
      sensitivePaths: ['src/**', TEST_MAP_PATH],
      touched: ['src/a.ts'],
      unmeasured,
    });
    keysOf(brewing(), untouched.actions);
    const result = await untouched.actions.target.apply(push);
    assert.deepEqual(result, {
      branch,
      commit: tip,
      from,
      sensitive: { count: 1, files: ['src/a.ts'] },
    });
    assert.equal(asked.length, 1);
  });
});
