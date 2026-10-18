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
import type { BrewerRunner } from '../../src/engine/brewer-runner.ts';
import { createCommandLog } from '../../src/engine/command-log.ts';
import { type Driver, openDriver } from '../../src/engine/driver.ts';
import {
  type BranchPush,
  type PullRequestHost,
  pullRequestActions,
} from '../../src/engine/pull-request-actions.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
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
] as const;
type KillPoint = (typeof killPoints)[number];

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
const codeHost = (kills: readonly KillPoint[]) => {
  const remote = new Map<string, string>();
  const pushes: string[] = [];
  const opened = new Map<string, string>();
  const left = [...kills];
  let dead = false;
  const point = (at: KillPoint): void => {
    if (dead) throw new Killed('dead');
    if (left[0] !== at) return;
    left.shift();
    dead = true;
    throw new Killed(at);
  };
  const push: BranchPush = {
    commit: async () => {
      point('before the push reached the remote');
      return FAKE_COMMIT;
    },
    remoteTip: async (branch) => remote.get(branch),
    push: async (commit, branch) => {
      point('before the push reached the remote');
      pushes.push(`${commit} ${branch}`);
      remote.set(branch, commit);
      point('after the push reached the remote');
    },
  };
  const host: PullRequestHost = {
    find: async (_repo, head) => opened.get(head),
    open: async (_repo, request) => {
      point('before the pull request was opened');
      const url = `https://github.com/acme/app/pull/${opened.size + 1}`;
      opened.set(request.head, url);
      point('after the pull request was opened');
      return url;
    },
  };
  return {
    push,
    host,
    remote,
    pushes,
    opened,
    /** A new driver process: alive, until its next kill point. */
    restart: () => {
      dead = false;
    },
    kills: () => kills.length - left.length,
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
  const store = openSqliteEventStore(join(dir.path, `run-${++runs}.sqlite`));
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
        // The driver died at a kill point: what it kept in memory is gone.
        driver.close();
        driver = undefined;
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
  // effect is not reached twice: the next driver finds the effect there.
  const runsOf: (readonly KillPoint[])[] = [
    [],
    ...killPoints.map((point) => [point]),
    ...killPoints.flatMap((first, i) =>
      killPoints
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
