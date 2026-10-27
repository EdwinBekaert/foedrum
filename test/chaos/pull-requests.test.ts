// The openPullRequest action through the real driver, killed on both sides of the push and of the
// open (ADR 0071, I4): a driver dies as the push or the pull request reaches the code host, before
// or after, once or twice in a run, and a new one starts on the same store. Whatever the kills, the
// batch goes on tap with exactly one pull request, from exactly one push. What survives a kill is
// the database and the code host; the remote and the pull requests are this test's own fakes, so
// no process starts and nothing reaches GitHub.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { attemptKey } from '../../src/engine/attempt-key.ts';
import { baseConflictEffects } from '../../src/engine/base-check.ts';
import type { BaseMerge } from '../../src/engine/base-merge.ts';
import type { BrewerRunner } from '../../src/engine/brewer-runner.ts';
import { createCommandLog } from '../../src/engine/command-log.ts';
import { type Driver, openDriver } from '../../src/engine/driver.ts';
import type { EventStore, EventStoreTransaction } from '../../src/engine/event-store.ts';
import { type MergeBriefHost, mergeBriefEffects } from '../../src/engine/merge-brief-post.ts';
import {
  type BranchPush,
  type PullRequestHost,
  pullRequestActions,
} from '../../src/engine/pull-request-actions.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import type { Event } from '../../src/schemas/events.ts';
import { defaultLimits } from '../helpers/brewing.ts';
import { fakeLock } from '../helpers/fake-lock.ts';
import { fakeRecipe, fakeRecipes } from '../helpers/fake-recipes.ts';
import { FAKE_COMMIT, fakeWorktrees } from '../helpers/fake-worktrees.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';

const killPoints = [
  'before the push reached the remote',
  'after the push reached the remote',
  'before the pull request was opened',
  'after the pull request was opened',
  'before the body was updated',
  'after the body was updated',
] as const;
type KillPoint = (typeof killPoints)[number];
// Where a fix the merged tree sent back dies besides (ADR 0226): around its start merge and the
// post of the failure.
const mergedPoints = [
  'before the start merge',
  'after the start merge',
  'before the failure was posted',
  'after the failure was posted',
] as const;
type AnyPoint = KillPoint | (typeof mergedPoints)[number];

class Killed extends Error {}

const recipes = fakeRecipes({
  ale: fakeRecipe({
    steps: ['plan', 'open-pull-request'],
    actions: { 'open-pull-request': 'openPullRequest' },
    pullRequests: [],
  }),
});
const t0 = new Date('2026-10-18T12:00:00.000Z');

/** A runner whose every attempt succeeds at once with an out doc. */
const runner: BrewerRunner = {
  start: () => ({
    ended: Promise.resolve({
      ending: {
        kind: 'succeeded',
        output: { status: 'done', summary: 'Planned', assumptions: [] },
      },
    }),
    stop: () => {},
  }),
  progress: () => undefined,
};

/**
 * The code host: a remote that keeps every push and the pull requests the Brewery opened, both of
 * which outlive the driver. `kills` says where the live driver dies, each the first time it gets
 * there; a dead driver touches nothing more.
 */
const codeHost = (kills: readonly AnyPoint[]) => {
  const remote = new Map<string, string>();
  const pushes: string[] = [];
  const opened = new Map<string, string>();
  const bodies = new Map<string, string>();
  const updates: string[] = [];
  const left = [...kills];
  let dead = false;
  let killed = 0;
  const point = (at: AnyPoint): void => {
    if (dead) throw new Killed('dead');
    if (left[0] !== at) return;
    left.shift();
    dead = true;
    killed++;
    throw new Killed(at);
  };
  const push: BranchPush = {
    // The task tree is at FAKE_COMMIT, the base elsewhere.
    commit: async () => {
      point('before the push reached the remote');
      return FAKE_COMMIT;
    },
    baseTip: async () => {
      point('before the push reached the remote');
      return 'b'.repeat(40);
    },
    isAncestor: async (commit, of) => commit === of,
    remoteTip: async (branch) => remote.get(branch),
    push: async (commit, branch) => {
      point('before the push reached the remote');
      pushes.push(`${commit} ${branch}`);
      remote.set(branch, commit);
      point('after the push reached the remote');
    },
    secretScan: async () => [],
    touchedFiles: async () => [],
  };
  const host: PullRequestHost = {
    find: async (_repo, head) => opened.get(head),
    open: async (_repo, request) => {
      point('before the pull request was opened');
      const url = `https://github.com/acme/app/pull/${opened.size + 1}`;
      opened.set(request.head, url);
      bodies.set(url, request.body);
      point('after the pull request was opened');
      return url;
    },
    body: async (url) => bodies.get(url) ?? assert.fail(`no pull request ${url}`),
    update: async (url, body) => {
      point('before the body was updated');
      updates.push(url);
      bodies.set(url, body);
      point('after the body was updated');
    },
  };
  return {
    push,
    host,
    remote,
    pushes,
    opened,
    bodies,
    updates,
    /** A new driver process: alive, until its next kill point. */
    restart: () => {
      dead = false;
    },
    kills: () => killed,
    /** Dies here when it is the next kill point; throws once dead. */
    point,
    /** Whether the live driver died. */
    dead: () => dead,
    /** Where the live driver dies from now on, each the first time it gets there. */
    arm: (more: readonly AnyPoint[]) => {
      left.push(...more);
    },
  };
};

let dir: TempDir;
before(() => {
  dir = makeTempDir('chaos-pull-requests');
});
after(() => dir.remove());
let runs = 0;

/** Brews one batch of the ale recipe to its end with `kills`, restarting after each one. */
const brew = async (kills: readonly KillPoint[]) => {
  const path = join(dir.path, `run-${++runs}.sqlite`);
  let store = openSqliteEventStore(path);
  const code = codeHost(kills);
  const worktrees = fakeWorktrees();
  const log = createCommandLog({ store, recipes });
  log.issue({ kind: 'order', batchId: '12-1', order: { issue: 12 } }, t0);
  log.issue(
    { kind: 'route', batchId: '12-1', recipe: 'ale', reason: 'label', source: 'label' },
    t0,
  );
  let starts = 0;
  let driver: Driver | undefined;
  try {
    for (let ticks = 0; ticks < 20; ticks++) {
      if (driver === undefined) {
        code.restart();
        starts++;
        driver = await openDriver({
          store,
          runner,
          recipes,
          clock: () => t0,
          lock: () => fakeLock('cellar'),
          takes: () => true,
          stateBranch: { flush: async () => ({ kind: 'unchanged' }) },
          limits: () => defaultLimits,
          worktrees: [{ repo: 'acme/app', base: 'origin/main', manager: worktrees }],
          actions: pullRequestActions({
            brewery: 'acme/brewery',
            repositories: [{ repo: 'acme/app', base: 'main', push: code.push }],
            host: code.host,
            orderTitle: async () => 'Add a --json flag',
          }),
        });
      }
      await driver.tick();
      if (code.kills() >= starts) {
        // The driver died at a kill point: what it kept in memory is gone, and the next process
        // opens the store from its file.
        driver.close();
        driver = undefined;
        store.close();
        store = openSqliteEventStore(path);
        continue;
      }
      if (driver.state().batches.get('12-1')?.lane.kind === 'on_tap') break;
    }
    const state = createCommandLog({ store, recipes }).state();
    return { state, code, starts };
  } finally {
    driver?.close();
    store.close();
  }
};

describe('chaos: the openPullRequest action killed around the push and the open (ADR 0071)', () => {
  // Every kill point once, and every two in the order a run reaches them: a later point, or a
  // point before an effect again, which the next driver reaches once more. A point after an
  // effect is not reached twice: the next driver finds the effect there. The first round renders
  // no body again.
  const points = killPoints.filter((point) => !point.includes('body'));
  const runsOf: (readonly KillPoint[])[] = [
    [],
    ...points.map((point) => [point]),
    ...points.flatMap((first, i) =>
      points
        .filter((second, j) => j > i || (j === i && second.startsWith('before')))
        .map((second) => [first, second]),
    ),
  ];

  for (const kills of runsOf) {
    it(`goes on tap with one pull request from one push: ${kills.join(', then ') || 'no kill'}`, async () => {
      const { state, code, starts } = await brew(kills);
      const branch = 'foedrum/acme.brewery/12-1/acme.app';
      assert.equal(starts, kills.length + 1, 'a new driver after each kill');
      assert.deepEqual(code.pushes, [`${FAKE_COMMIT} ${branch}`]);
      assert.deepEqual([...code.opened], [[branch, 'https://github.com/acme/app/pull/1']]);
      assert.deepEqual(code.updates, []);
      assert.deepEqual(state.batches.get('12-1')?.lane, {
        kind: 'on_tap',
        pullRequests: ['https://github.com/acme/app/pull/1'],
      });
      assert.deepEqual([...state.effects.keys()].sort(), [
        JSON.stringify(['12-1', 'pull_request']),
        JSON.stringify(['12-1', 'push']),
      ]);
      const ends = [
        ...(state.batches.get('12-1')?.steps.get('open-pull-request')?.attempts.values() ?? []),
      ];
      assert.deepEqual(
        ends.map((attempt) => attempt.phase),
        ['finished'],
        `one attempt of the action: ${ends.map((a) => attemptKey.encode({ batchId: '12-1', stepId: 'open-pull-request', attempt: a.attempt })).join(', ')}`,
      );
    });
  }
});

// A pull request whose checks failed on the pushed head goes back to `plan` and its fix is pushed
// to the same branch (ADR 0219), killed on both sides of that round's push, once or twice. The
// first round brews without kills; the round's task tree is plan's second attempt, at FIXED.
const FIXED = 'e'.repeat(40);
const fixing = fakeRecipes({
  ale: fakeRecipe({
    steps: ['plan', 'open-pull-request'],
    actions: { 'open-pull-request': 'openPullRequest' },
    routes: { 'open-pull-request': { pull_request: 'plan' } },
    maxRounds: 2,
    pullRequests: [],
  }),
});

const fixRun = async (kills: readonly KillPoint[]) => {
  const path = join(dir.path, `run-${++runs}.sqlite`);
  let store = openSqliteEventStore(path);
  const code = codeHost([]);
  const commitOf = code.push.commit;
  // The fix's task tree is plan's second attempt.
  const push: BranchPush = {
    ...code.push,
    commit: async (revision, signal) => {
      const commit = await commitOf(revision, signal);
      return revision.endsWith('/plan/2') ? FIXED : commit;
    },
  };
  const worktrees = fakeWorktrees();
  const log = createCommandLog({ store, recipes: fixing });
  log.issue({ kind: 'order', batchId: '12-1', order: { issue: 12 } }, t0);
  log.issue(
    { kind: 'route', batchId: '12-1', recipe: 'ale', reason: 'label', source: 'label' },
    t0,
  );
  let starts = 0;
  let driver: Driver | undefined;
  let failed = false;
  const roundDone = (): boolean => {
    const batch = driver?.state().batches.get('12-1');
    return batch?.lane.kind === 'on_tap' && (batch.steps.get('plan')?.attempts.size ?? 0) === 2;
  };
  try {
    for (let ticks = 0; ticks < 40; ticks++) {
      if (driver === undefined) {
        code.restart();
        starts++;
        driver = await openDriver({
          store,
          runner,
          recipes: fixing,
          clock: () => t0,
          lock: () => fakeLock('cellar'),
          takes: () => true,
          stateBranch: { flush: async () => ({ kind: 'unchanged' }) },
          limits: () => defaultLimits,
          worktrees: [{ repo: 'acme/app', base: 'origin/main', manager: worktrees }],
          actions: pullRequestActions({
            brewery: 'acme/brewery',
            repositories: [{ repo: 'acme/app', base: 'main', push }],
            host: code.host,
            orderTitle: async () => 'Add a --json flag',
          }),
        });
      }
      await driver.tick();
      if (code.kills() >= starts) {
        driver.close();
        driver = undefined;
        store.close();
        store = openSqliteEventStore(path);
        continue;
      }
      if (!failed && driver.state().batches.get('12-1')?.lane.kind === 'on_tap') {
        // The intake reads the pull request's checks: the first round's head failed.
        const event: Extract<Event, { type: 'pull_request.checks_finished' }> = {
          type: 'pull_request.checks_finished',
          batchId: '12-1',
          pullRequest: 'https://github.com/acme/app/pull/1',
          head: FAKE_COMMIT,
          checks: [{ name: 'ci / test', kind: 'check_run', conclusion: 'failure' }],
        };
        assert.equal(
          createCommandLog({ store, recipes: fixing }).issue({ kind: 'record', event }, t0).kind,
          'accepted',
        );
        failed = true;
        code.arm(kills);
        continue;
      }
      if (roundDone()) break;
    }
    const state = createCommandLog({ store, recipes: fixing }).state();
    return { state, code, starts };
  } finally {
    driver?.close();
    store.close();
  }
};

describe('chaos: a fix round of a failing pull request killed around its push and its body (ADR 0219, ADR 0227)', () => {
  const pushPoints = killPoints.filter((point) => point.includes('push') || point.includes('body'));
  const runsOf: (readonly KillPoint[])[] = [
    [],
    ...pushPoints.map((point) => [point]),
    ...pushPoints.flatMap((first, i) =>
      pushPoints
        .filter((second, j) => j > i || (j === i && second.startsWith('before')))
        .map((second) => [first, second]),
    ),
  ];

  for (const kills of runsOf) {
    it(`pushes the fix once to the same pull request and renders its body once: ${kills.join(', then ') || 'no kill'}`, async () => {
      const { state, code, starts } = await fixRun(kills);
      const branch = 'foedrum/acme.brewery/12-1/acme.app';
      assert.equal(starts, kills.length + 1, 'a new driver after each kill');
      assert.deepEqual(code.pushes, [`${FAKE_COMMIT} ${branch}`, `${FIXED} ${branch}`]);
      assert.equal(code.remote.get(branch), FIXED);
      assert.deepEqual([...code.opened], [[branch, 'https://github.com/acme/app/pull/1']]);
      assert.deepEqual(state.batches.get('12-1')?.lane, {
        kind: 'on_tap',
        pullRequests: ['https://github.com/acme/app/pull/1'],
      });
      assert.deepEqual([...state.effects.keys()].sort(), [
        JSON.stringify(['12-1', 'body.2']),
        JSON.stringify(['12-1', 'pull_request']),
        JSON.stringify(['12-1', 'push']),
        JSON.stringify(['12-1', 'push.2']),
      ]);
      assert.deepEqual(code.updates, ['https://github.com/acme/app/pull/1']);
      assert.match(
        code.bodies.get('https://github.com/acme/app/pull/1') ?? '',
        /\n<!-- foedrum:\["12-1","body\.2"\] sha256:[0-9a-f]{16} -->$/,
      );
    });
  }
});

// The merge brief of a ready pull request (ADR 0225), killed on both sides of its post, once or
// twice, and once with the record changing while no driver runs. The batch brews to On tap
// without kills, then its checks pass on the pushed head.
const briefPoints = ['before the brief was posted', 'after the brief was posted'] as const;
type BriefPoint = (typeof briefPoints)[number];

const briefRun = async (kills: readonly BriefPoint[], late = false) => {
  const path = join(dir.path, `run-${++runs}.sqlite`);
  let store = openSqliteEventStore(path);
  const code = codeHost([]);
  const comments: { id: number; body: string }[] = [];
  const left = [...kills];
  let dead = false;
  let killed = 0;
  const point = (at: BriefPoint): void => {
    if (dead) throw new Killed('dead');
    if (left[0] !== at) return;
    left.shift();
    dead = true;
    killed++;
    throw new Killed(at);
  };
  const host: MergeBriefHost = {
    find: async (_repo, _number, marker) => {
      if (dead) throw new Killed('dead');
      return comments.find(({ body }) => body.endsWith(marker));
    },
    create: async (_repo, _number, body) => {
      point('before the brief was posted');
      comments.push({ id: comments.length + 1, body });
      point('after the brief was posted');
      return comments.length;
    },
    title: async () => 'Add a --json flag',
  };
  const worktrees = fakeWorktrees();
  const record = (checks: Extract<Event, { type: 'pull_request.checks_finished' }>['checks']) => {
    const event: Extract<Event, { type: 'pull_request.checks_finished' }> = {
      type: 'pull_request.checks_finished',
      batchId: '12-1',
      pullRequest: 'https://github.com/acme/app/pull/1',
      head: FAKE_COMMIT,
      checks,
    };
    assert.equal(
      createCommandLog({ store, recipes }).issue({ kind: 'record', event }, t0).kind,
      'accepted',
    );
  };
  const log = createCommandLog({ store, recipes });
  log.issue({ kind: 'order', batchId: '12-1', order: { issue: 12 } }, t0);
  log.issue(
    { kind: 'route', batchId: '12-1', recipe: 'ale', reason: 'label', source: 'label' },
    t0,
  );
  let starts = 0;
  let driver: Driver | undefined;
  let checked = false;
  const briefKey = JSON.stringify(['12-1', 'brief.1']);
  try {
    for (let ticks = 0; ticks < 40; ticks++) {
      if (driver === undefined) {
        dead = false;
        starts++;
        driver = await openDriver({
          store,
          runner,
          recipes,
          clock: () => t0,
          lock: () => fakeLock('cellar'),
          takes: () => true,
          stateBranch: { flush: async () => ({ kind: 'unchanged' }) },
          limits: () => defaultLimits,
          worktrees: [{ repo: 'acme/app', base: 'origin/main', manager: worktrees }],
          effects: mergeBriefEffects({ host, recipes }),
          actions: pullRequestActions({
            brewery: 'acme/brewery',
            repositories: [{ repo: 'acme/app', base: 'main', push: code.push }],
            host: code.host,
            orderTitle: async () => 'Add a --json flag',
          }),
        });
      }
      await driver.tick();
      if (killed >= starts) {
        driver.close();
        driver = undefined;
        store.close();
        store = openSqliteEventStore(path);
        // While no driver runs, a check registers late and passes: another ready record.
        if (late && killed === 1)
          record([
            { name: 'ci / test', kind: 'check_run', conclusion: 'success' },
            { name: 'ci / late', kind: 'check_run', conclusion: 'success' },
          ]);
        continue;
      }
      if (!checked && driver.state().batches.get('12-1')?.lane.kind === 'on_tap') {
        record([{ name: 'ci / test', kind: 'check_run', conclusion: 'success' }]);
        checked = true;
        continue;
      }
      if (driver.state().effects.has(briefKey)) break;
    }
    const state = createCommandLog({ store, recipes }).state();
    return { state, comments, starts };
  } finally {
    driver?.close();
    store.close();
  }
};

describe('chaos: the merge brief killed around its post (ADR 0225)', () => {
  const runsOf: (readonly BriefPoint[])[] = [
    [],
    ...briefPoints.map((point) => [point]),
    [briefPoints[0], briefPoints[0]],
    [briefPoints[0], briefPoints[1]],
  ];

  for (const kills of runsOf) {
    it(`posts one brief for the ready record: ${kills.join(', then ') || 'no kill'}`, async () => {
      const { state, comments, starts } = await briefRun(kills);
      assert.equal(starts, kills.length + 1, 'a new driver after each kill');
      assert.equal(comments.length, 1);
      assert.match(comments[0]?.body ?? '', /^### Merge\? Add a --json flag @ /);
      assert.deepEqual(
        [...state.effects.keys()].filter((key) => key.includes('brief')),
        [JSON.stringify(['12-1', 'brief.1'])],
      );
      assert.equal(
        (state.effects.get(JSON.stringify(['12-1', 'brief.1'])) as { comment: number }).comment,
        1,
      );
    });
  }

  it('posts the changed record its own brief when a kill left an older one', async () => {
    const { state, comments } = await briefRun([briefPoints[1]], true);
    assert.equal(comments.length, 2);
    assert.match(comments[1]?.body ?? '', /ci \/ late/);
    assert.equal(
      (state.effects.get(JSON.stringify(['12-1', 'brief.1'])) as { comment: number }).comment,
      2,
    );
  });
});

// A pull request whose merged tree fails a check goes back to `plan`, which merges the base at its
// start, and its fix is pushed to the same branch, while the failure is posted (ADR 0226): killed
// on both sides of the start merge, the push and the post, once or twice. The first round brews
// without kills.
const TIP = 'f'.repeat(40);
const MERGED = 'd'.repeat(40);
const mergedFixing = fakeRecipes({
  ale: fakeRecipe({
    steps: ['plan', 'open-pull-request'],
    actions: { 'open-pull-request': 'openPullRequest' },
    routes: { 'open-pull-request': { pull_request: 'plan' } },
    maxRounds: 2,
    // A kill loses the attempt it ran: the fix gets more than one.
    maxAttempts: 5,
    pullRequests: [],
  }),
});

const mergedRun = async (kills: readonly AnyPoint[]) => {
  const path = join(dir.path, `run-${++runs}.sqlite`);
  const code = codeHost([]);
  // A dead driver writes nothing more: a kill inside an effect is no failure it records.
  const opened = (): EventStore => {
    const inner = openSqliteEventStore(path);
    return new Proxy(inner, {
      get: (target, key) =>
        key === 'withTransaction'
          ? <T>(fn: (tx: EventStoreTransaction) => T): T => {
              if (code.dead()) throw new Killed('dead');
              return target.withTransaction(fn);
            }
          : Reflect.get(target, key, target),
    });
  };
  let store = opened();
  const commitOf = code.push.commit;
  // A fix's task tree is a later attempt of plan.
  const push: BranchPush = {
    ...code.push,
    commit: async (revision, signal) => {
      const commit = await commitOf(revision, signal);
      return /\/plan\/[2-9]$/.test(revision) ? FIXED : commit;
    },
  };
  // A worktree's HEAD outlives the driver, as a merge in it does.
  const heads = new Map<string, string>();
  const merges: string[] = [];
  const merge: BaseMerge = {
    base: 'main',
    push: { baseTip: async () => TIP, isAncestor: async (commit, of) => commit === of },
    worktree: {
      head: async (at) => heads.get(at) ?? FAKE_COMMIT,
      parents: async (at, commit) => (commit === heads.get(at) ? [FAKE_COMMIT, TIP] : []),
      abort: async () => {},
      merge: async (at) => {
        code.point('before the start merge');
        heads.set(at, MERGED);
        merges.push(at);
        code.point('after the start merge');
        return { kind: 'merged', commit: MERGED };
      },
    },
  };
  // The pull request's comments outlive the driver too.
  const comments: string[] = [];
  const marks = {
    findComment: async (_repo: string, _issue: number, marker: string) => {
      const at = comments.findIndex((body) => body.includes(marker));
      return at === -1 ? undefined : at + 1;
    },
    comment: async (_repo: string, _issue: number, body: string) => {
      code.point('before the failure was posted');
      comments.push(body);
      code.point('after the failure was posted');
      return comments.length;
    },
  };
  const worktrees = fakeWorktrees();
  const log = createCommandLog({ store, recipes: mergedFixing });
  log.issue({ kind: 'order', batchId: '12-1', order: { issue: 12 } }, t0);
  log.issue(
    { kind: 'route', batchId: '12-1', recipe: 'ale', reason: 'label', source: 'label' },
    t0,
  );
  let starts = 0;
  let driver: Driver | undefined;
  let failed = false;
  const roundDone = (): boolean => {
    const state = driver?.state();
    const posted = state?.effects.has(JSON.stringify(['12-1', 'base_check_failed.1']));
    return (
      state?.batches.get('12-1')?.lane.kind === 'on_tap' &&
      state.effects.has(JSON.stringify(['12-1', 'push.2'])) &&
      posted === true
    );
  };
  try {
    for (let ticks = 0; ticks < 40; ticks++) {
      if (driver === undefined) {
        code.restart();
        starts++;
        driver = await openDriver({
          store,
          runner,
          recipes: mergedFixing,
          clock: () => t0,
          lock: () => fakeLock('cellar'),
          takes: () => true,
          stateBranch: { flush: async () => ({ kind: 'unchanged' }) },
          limits: () => defaultLimits,
          worktrees: [{ repo: 'acme/app', base: 'origin/main', manager: worktrees, merge }],
          effects: baseConflictEffects({ marks, recipes: mergedFixing }),
          actions: pullRequestActions({
            brewery: 'acme/brewery',
            repositories: [{ repo: 'acme/app', base: 'main', push }],
            host: code.host,
            orderTitle: async () => 'Add a --json flag',
          }),
        });
      }
      await driver.tick().catch((error: unknown) => {
        if (!(error instanceof Killed)) throw error;
      });
      if (code.kills() >= starts) {
        driver.close();
        driver = undefined;
        store.close();
        store = opened();
        continue;
      }
      if (!failed && driver.state().batches.get('12-1')?.lane.kind === 'on_tap') {
        // The merged-check run: the first round's head fails on the merged tree with main at TIP.
        const event: Extract<Event, { type: 'pull_request.base_checked' }> = {
          type: 'pull_request.base_checked',
          batchId: '12-1',
          pullRequest: 'https://github.com/acme/app/pull/1',
          branch: 'main',
          tip: TIP,
          head: FAKE_COMMIT,
          failed: {
            result: 'exited',
            check: 'test',
            command: 'npm test',
            exitCode: 1,
            tail: 'not ok 1',
          },
        };
        assert.equal(
          createCommandLog({ store, recipes: mergedFixing }).issue({ kind: 'record', event }, t0)
            .kind,
          'accepted',
        );
        failed = true;
        code.arm(kills);
        continue;
      }
      if (roundDone()) break;
    }
    const state = createCommandLog({ store, recipes: mergedFixing }).state();
    return { state, code, starts, merges, comments };
  } finally {
    driver?.close();
    store.close();
  }
};

describe('chaos: a fix the merged tree sent back killed around its merge, push and post (ADR 0226)', () => {
  const points: readonly AnyPoint[] = [
    ...mergedPoints,
    ...killPoints.filter((point) => point.includes('push')),
  ];
  const runsOf: (readonly AnyPoint[])[] = [
    [],
    ...points.map((point) => [point]),
    ...points.flatMap((first, i) =>
      points
        .filter((second, j) => j > i || (j === i && second.startsWith('before')))
        .map((second) => [first, second]),
    ),
  ];

  for (const kills of runsOf) {
    it(`merges the base, pushes the fix and posts once: ${kills.join(', then ') || 'no kill'}`, async () => {
      const { state, code, starts, merges, comments } = await mergedRun(kills);
      const branch = 'foedrum/acme.brewery/12-1/acme.app';
      assert.equal(starts, kills.length + 1, 'a new driver after each kill');
      assert.deepEqual(code.pushes, [`${FAKE_COMMIT} ${branch}`, `${FIXED} ${branch}`]);
      assert.equal(code.remote.get(branch), FIXED);
      assert.deepEqual(state.batches.get('12-1')?.lane, {
        kind: 'on_tap',
        pullRequests: ['https://github.com/acme/app/pull/1'],
      });
      assert.equal(comments.length, 1, 'one post of the failure');
      assert.match(comments[0] ?? '', /Foedrum sends the batch back to fix it, at most 2 rounds/);
      // The fix's attempts each merged the base at their start, a worktree at most once.
      assert.equal(new Set(merges).size, merges.length);
      const plans = [...(state.batches.get('12-1')?.steps.get('plan')?.attempts.values() ?? [])];
      const succeeded = plans.filter(
        (attempt) => attempt.phase === 'finished' && attempt.outcome.kind === 'succeeded',
      );
      const fix = succeeded.at(-1);
      assert.ok(fix !== undefined && fix.attempt > 1);
      assert.deepEqual(
        state.effects.get(JSON.stringify(['12-1', 'plan', fix.attempt, 'merge_base'])),
        { base: TIP, merged: MERGED },
      );
    });
  }
});
