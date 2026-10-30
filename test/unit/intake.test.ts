// The intake of target-repository issues (ADR 0043, #103): one pass records the end of each pull
// request of a claimed batch on tap, then claims candidates up to the Brewery's free capacity and
// orders what it won. A fake GitHub and a fake tracker, no network (ADR 0021).

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { claimEffects } from '../../src/engine/claim-effects.ts';
import { type CommandLog, createCommandLog } from '../../src/engine/command-log.ts';
import type { Ending } from '../../src/engine/decide.ts';
import { effectKey } from '../../src/engine/effect-key.ts';
import type { EventStore } from '../../src/engine/event-store.ts';
import {
  createIntake,
  freeCapacity,
  type IntakeNotice,
  type IntakeOptions,
  intakeRepositories,
  type TargetTracker,
} from '../../src/engine/intake.ts';
import type { Claimant, PullRequestState, TargetIssue } from '../../src/engine/issue-claims.ts';
import { pullRequestKey, pushKey } from '../../src/engine/pull-request.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import { BreweryConfig } from '../../src/schemas/brewery-config.ts';
import { type FakeGitHub, fakeGitHub } from '../helpers/fake-github.ts';
import { createdOf } from '../helpers/fake-github-api.ts';
import { fakeRecipe, fakeRecipes } from '../helpers/fake-recipes.ts';
import {
  checksFinished,
  firstHead,
  fixRound,
  openedOnTap,
  secondHead,
} from '../helpers/open-pull-request.ts';

const web = 'acme/web';
const api = 'acme/api';
const pullRequest = 'https://github.com/acme/web/pull/12';
const now = new Date('2026-10-16T09:00:00.000Z');
const alice: Claimant = { brewery: 'alice/brewery', login: 'alice' };
const bob: Claimant = { brewery: 'bob/brewery', login: 'bob' };
const recipes = fakeRecipes({
  half: fakeRecipe({ steps: ['plan'], pullRequests: [pullRequest] }),
  nip: fakeRecipe({ steps: ['plan'] }),
  other: fakeRecipe({ steps: ['plan'] }),
});
const succeeded: Ending = {
  kind: 'succeeded',
  output: { status: 'done', summary: 'Done', assumptions: [] },
};
const repositories: IntakeOptions['repositories'] = [
  { repo: web, alias: 'web', filter: { labels: ['foedrum'] } },
  { repo: api, alias: 'api', filter: { labels: ['foedrum'] } },
];

const issue = (number: number, fields: Partial<TargetIssue> = {}): TargetIssue => ({
  number,
  state: 'open',
  pullRequest: false,
  labels: ['foedrum'],
  milestone: undefined,
  assignees: [],
  author: 'alice',
  // A minute apart by number, so the lower number arrived first (ADR 0208).
  created: createdOf(number),
  ...fields,
});
const record = (brewery: string, number: number): string =>
  JSON.stringify({ brewery, issue: number, claimedAt: now.toISOString() });

/** A tracker with the open issues of each repository and the state of each pull request. */
const fakeTracker = (
  issues: Record<string, TargetIssue[]>,
  pullRequests: Record<string, PullRequestState> = {},
) => {
  const asked: string[] = [];
  const tracker: TargetTracker = {
    issues: async (repo) => {
      asked.push(`issues ${repo}`);
      const listed = issues[repo];
      if (listed === undefined) throw new Error(`502 listing ${repo}`);
      return listed;
    },
    pullRequest: async (url) => {
      asked.push(`pull request ${url}`);
      const state = pullRequests[url];
      if (state === undefined) throw new Error(`502 reading ${url}`);
      return state;
    },
  };
  return { tracker, asked, pullRequests };
};

describe('createIntake', () => {
  let store: EventStore;
  let log: CommandLog;
  let github: FakeGitHub;
  let notices: IntakeNotice[];

  beforeEach(() => {
    store = openSqliteEventStore(':memory:');
    log = createCommandLog({ store, recipes });
    github = fakeGitHub();
    notices = [];
  });
  afterEach(() => store.close());

  const intake = (tracker: TargetTracker, options: Partial<IntakeOptions> = {}) =>
    createIntake({
      log,
      tracker,
      claims: github.host,
      claimant: alice,
      authors: ['alice', 'bob'],
      repositories,
      capacity: 5,
      clock: () => now,
      report: (notice) => notices.push(notice),
      ...options,
    });
  const batches = () =>
    [...log.state().batches.values()].map(({ id, repo, issue: number, lane }) => ({
      id,
      repo,
      issue: number,
      lane: lane.kind,
    }));
  const accept = (command: Parameters<CommandLog['issue']>[0]): void =>
    assert.equal(log.issue(command, now).kind, 'accepted');

  it('claims a labelled issue and orders it as <alias>-<issue>, with a routing deadline', async () => {
    const { tracker } = fakeTracker({ [web]: [issue(7)], [api]: [] });
    await intake(tracker).poll();
    const batch = log.state().batches.get('web-7');
    assert.deepStrictEqual(
      { repo: batch?.repo, issue: batch?.issue, lane: batch?.lane },
      { repo: web, issue: 7, lane: { kind: 'ordered', routeBy: '2026-10-16T10:00:00.000Z' } },
    );
    assert.equal(github.refs.get(`${web}#7`), record(alice.brewery, 7));
    assert.deepStrictEqual(notices, [{ kind: 'ordered', repo: web, issue: 7, batchId: 'web-7' }]);
  });

  it('orders the oldest candidates first, only up to the free capacity', async () => {
    // One Brewery batch already takes one of the three places.
    accept({ kind: 'order', batchId: '1-1', order: { issue: 1 } });
    const { tracker } = fakeTracker({ [web]: [issue(9), issue(3), issue(5)], [api]: [issue(2)] });
    await intake(tracker, { capacity: 3 }).poll();
    assert.deepStrictEqual(
      batches().map(({ id }) => id),
      ['1-1', 'api-2', 'web-3'],
    );
    assert.equal(github.refs.has(`${web}#9`), false, 'the rest stay unclaimed');
    assert.equal(github.refs.has(`${web}#5`), false);
  });

  it('shares the capacity between repositories by arrival, not in the order the config names them (ADR 0208)', async () => {
    const { tracker } = fakeTracker({ [web]: [issue(4)], [api]: [issue(2), issue(3)] });
    await intake(tracker, { capacity: 2 }).poll();
    assert.deepStrictEqual(
      batches().map(({ id }) => id),
      ['api-2', 'api-3'],
    );
  });

  it('lists no issues when it has no free capacity', async () => {
    accept({ kind: 'order', batchId: '1-1', order: { issue: 1 } });
    const { tracker, asked } = fakeTracker({ [web]: [issue(7)], [api]: [] });
    await intake(tracker, { capacity: 1 }).poll();
    assert.deepStrictEqual(asked, []);
    assert.equal(github.refs.size, 0);
  });

  it('skips an issue another Brewery claimed, reports it, and orders the next one instead', async () => {
    github.setRef(web, 3, record(bob.brewery, 3));
    const { tracker } = fakeTracker({ [web]: [issue(3), issue(4)], [api]: [] });
    await intake(tracker, { capacity: 1 }).poll();
    assert.deepStrictEqual(
      batches().map(({ id }) => id),
      ['web-4'],
    );
    assert.deepStrictEqual(notices, [
      { kind: 'taken', repo: web, issue: 3, by: bob.brewery },
      { kind: 'ordered', repo: web, issue: 4, batchId: 'web-4' },
    ]);
  });

  it('orders its own claim that a run killed before ordering left, and only once', async () => {
    github.setRef(web, 7, record(alice.brewery, 7));
    const { tracker } = fakeTracker({ [web]: [issue(7)], [api]: [] });
    const polling = intake(tracker);
    await polling.poll();
    await polling.poll();
    assert.deepStrictEqual(
      batches().map(({ id }) => id),
      ['web-7'],
    );
  });

  it('never orders an issue with a batch here again, whatever its lane, nor one of another repository', async () => {
    accept({ kind: 'order', batchId: 'web-7', order: { issue: 7, repo: 'Acme/Web' } });
    accept({ kind: 'cancel', batchId: 'web-7', by: 'alice', via: 'terminal' });
    const { tracker } = fakeTracker({ [web]: [issue(7)], [api]: [issue(7)] });
    await intake(tracker).poll();
    assert.deepStrictEqual(
      batches().map(({ id, lane }) => `${id} ${lane}`),
      ['web-7 cancelled', 'api-7 ordered'],
    );
  });

  it('lets exactly one of two Breweries that poll at the same time order an issue', async () => {
    const bobStore = openSqliteEventStore(':memory:');
    const bobLog = createCommandLog({ store: bobStore, recipes });
    try {
      const { tracker } = fakeTracker({ [web]: [issue(7), issue(8)], [api]: [] });
      const bobs = intake(tracker, { log: bobLog, claimant: bob });
      await Promise.all([intake(tracker).poll(), bobs.poll()]);
      const ours = [...log.state().batches.keys()];
      const theirs = [...bobLog.state().batches.keys()];
      assert.deepStrictEqual([...ours, ...theirs].sort(), ['web-7', 'web-8']);
    } finally {
      bobStore.close();
    }
  });

  describe('deadline of a pass', () => {
    /** acme/web lists issue 7 only after `ms`, whatever its signal says; acme/api lists none. */
    const slowTracker = (ms: number) => {
      const signals: (AbortSignal | undefined)[] = [];
      let first = true;
      const tracker: TargetTracker = {
        issues: async (repo, _filter, signal) => {
          signals.push(signal);
          if (repo === web && first) {
            first = false;
            await new Promise((resolve) => setTimeout(resolve, ms));
          }
          return repo === web ? [issue(7)] : [];
        },
        pullRequest: async () => 'open',
      };
      return { tracker, signals };
    };

    it('ends a pass a slow GitHub holds past its deadline, reports it, and orders nothing late', async () => {
      const { tracker, signals } = slowTracker(150);
      const polling = intake(tracker, { deadlineMs: 20 });
      await polling.poll();
      assert.equal(signals[0]?.aborted, true, 'the listing was told to stop');
      const failed = notices.find((notice) => notice.kind === 'failed');
      assert.equal(failed?.kind === 'failed' ? failed.what : '', 'the pass');
      assert.match(
        failed?.kind === 'failed' ? String(failed.error) : '',
        /took longer than its deadline of 20 ms/,
      );
      // The listing answers after the deadline: what the dead pass would order, it never does.
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.deepStrictEqual(batches(), []);
      await polling.poll();
      assert.deepStrictEqual(
        batches().map(({ id }) => id),
        ['web-7'],
      );
    });

    it('hands the claim host the pass signal too', async () => {
      const signals: (AbortSignal | undefined)[] = [];
      const recording = {
        ...github.host,
        create: async (into: string, number: number, message: string, signal?: AbortSignal) => {
          signals.push(signal);
          return github.host.create(into, number, message);
        },
      };
      const { tracker } = fakeTracker({ [web]: [issue(7)], [api]: [] });
      await intake(tracker, { claims: recording }).poll();
      assert.equal(signals.length, 1);
      assert.ok(signals[0] instanceof AbortSignal);
    });

    it('lasts half a batch lease when it names none', async () => {
      const { tracker } = fakeTracker({ [web]: [], [api]: [] });
      assert.doesNotThrow(() => intake(tracker, { deadlineMs: 150_000 }));
      await intake(tracker).poll();
      assert.deepStrictEqual(notices, []);
    });

    for (const deadlineMs of [0, 1.5, 150_001]) {
      it(`refuses a deadline of ${deadlineMs} ms, which must stay within half a batch lease`, () => {
        const { tracker } = fakeTracker({});
        assert.throws(
          () => intake(tracker, { deadlineMs }),
          /deadline of an intake pass must be a whole number of milliseconds up to 150000/,
        );
      });
    }
  });

  for (const capacity of [-1, 1.5, Number.NaN]) {
    it(`refuses a capacity of ${capacity} when it is made, not at every poll`, () => {
      const { tracker } = fakeTracker({});
      assert.throws(() => intake(tracker, { capacity }), /capacity must be a whole number/);
    });
  }

  it('runs one pass at a time, so two polls at once order an issue once', async () => {
    const { tracker } = fakeTracker({ [web]: [issue(7)], [api]: [] });
    const polling = intake(tracker);
    await Promise.all([polling.poll(), polling.poll()]);
    assert.deepStrictEqual(
      batches().map(({ id }) => id),
      ['web-7'],
    );
  });

  it('orders the claims it won before a claim failed, reports the failure, and goes on', async () => {
    const failing = {
      ...github.host,
      create: async (into: string, number: number, message: string) => {
        if (into === web && number === 3) throw new Error('502 Bad Gateway');
        return github.host.create(into, number, message);
      },
    };
    const { tracker } = fakeTracker({ [web]: [issue(1), issue(2), issue(3)], [api]: [issue(2)] });
    await intake(tracker, { claims: failing }).poll();
    assert.deepStrictEqual(
      batches().map(({ id }) => id),
      ['web-1', 'web-2', 'api-2'],
    );
    const failed = notices.find((notice) => notice.kind === 'failed');
    assert.equal(failed?.kind === 'failed' ? failed.what : '', `claiming ${web}#3`);
    assert.match(failed?.kind === 'failed' ? String(failed.error) : '', /502 Bad Gateway/);
  });

  it('reports a repository it cannot list, and goes on with the next one', async () => {
    const { tracker } = fakeTracker({ [api]: [issue(2)] });
    await intake(tracker).poll();
    assert.deepStrictEqual(
      batches().map(({ id }) => id),
      ['api-2'],
    );
    assert.equal(notices[0]?.kind, 'failed');
    assert.match(notices[0]?.kind === 'failed' ? String(notices[0].error) : '', /502 listing/);
  });

  describe('the end of a pull request', () => {
    /** web-7 on tap with `pullRequest`. */
    const onTap = (): void => {
      accept({ kind: 'order', batchId: 'web-7', order: { issue: 7, repo: web } });
      accept({ kind: 'route', batchId: 'web-7', recipe: 'half', reason: 'label', source: 'label' });
      const ref = { batchId: 'web-7', stepId: 'plan', attempt: 1 };
      accept({ kind: 'record', event: { type: 'step.started', ...ref } });
      accept({ kind: 'finish', ...ref, ending: succeeded });
    };
    const ends = () => log.state().batches.get('web-7')?.pullRequestEnds;

    for (const state of ['merged', 'closed'] as const) {
      it(`records a pull request of a claimed batch on tap that was ${state}, and asks no more`, async () => {
        onTap();
        const { tracker, asked } = fakeTracker({ [web]: [], [api]: [] }, { [pullRequest]: state });
        const polling = intake(tracker);
        await polling.poll();
        await polling.poll();
        assert.deepStrictEqual(ends(), { [pullRequest]: state });
        assert.deepStrictEqual(
          asked.filter((call) => call.startsWith('pull request')),
          [`pull request ${pullRequest}`],
        );
      });
    }

    it('records nothing while the pull request is open, and asks again next time', async () => {
      onTap();
      const { tracker, asked } = fakeTracker({ [web]: [], [api]: [] }, { [pullRequest]: 'open' });
      const polling = intake(tracker);
      await polling.poll();
      await polling.poll();
      assert.equal(ends(), undefined);
      assert.equal(asked.filter((call) => call.startsWith('pull request')).length, 2);
    });

    it('reports a pull request it cannot read, and still claims', async () => {
      onTap();
      const { tracker } = fakeTracker({ [web]: [issue(8)], [api]: [] });
      await intake(tracker).poll();
      assert.equal(ends(), undefined);
      assert.ok(log.state().batches.has('web-8'));
      const failed = notices.filter((notice) => notice.kind === 'failed');
      assert.deepStrictEqual(
        failed.map((notice) => notice.what),
        [`reading ${pullRequest}`],
      );
      assert.match(String(failed[0]?.error), /502 reading/);
    });

    it("records the end of a Brewery issue's pull request too, and nothing else changes for it (ADR 0198)", async () => {
      accept({ kind: 'order', batchId: '1-1', order: { issue: 1 } });
      accept({ kind: 'route', batchId: '1-1', recipe: 'half', reason: 'label', source: 'label' });
      const ref = { batchId: '1-1', stepId: 'plan', attempt: 1 };
      accept({ kind: 'record', event: { type: 'step.started', ...ref } });
      accept({ kind: 'finish', ...ref, ending: succeeded });
      const { tracker } = fakeTracker({ [web]: [], [api]: [] }, { [pullRequest]: 'merged' });
      const before = log.state();
      const marks = claimEffects({
        claimant: alice,
        marks: github.marks('alice'),
        claims: github.host,
      });
      assert.deepStrictEqual(marks.due(before, '1-1'), []);
      await intake(tracker).poll();
      const batch = log.state().batches.get('1-1');
      assert.deepStrictEqual(batch?.pullRequestEnds, { [pullRequest]: 'merged' });
      assert.equal(batch?.lane.kind, 'on_tap');
      // No release, no claim mark: those read only a claimed batch's ends (ADR 0043).
      assert.deepStrictEqual(marks.due(log.state(), '1-1'), []);
      assert.equal(github.refs.size, 0);
    });

    it('records the end of a pull request whose batch is brewing a fix of it (ADR 0219)', async () => {
      const [sentBack] = fixRound('1-1', firstHead, secondHead, 2, pullRequest);
      store.replay([
        ...openedOnTap('1-1', 'half', firstHead, pullRequest),
        checksFinished('1-1', firstHead, undefined, pullRequest),
        ...(sentBack === undefined ? [] : [sentBack]),
      ]);
      log = createCommandLog({ store, recipes });
      const { tracker } = fakeTracker({ [web]: [], [api]: [] }, { [pullRequest]: 'merged' });
      await intake(tracker).poll();
      const batch = log.state().batches.get('1-1');
      assert.deepStrictEqual(batch?.pullRequestEnds, { [pullRequest]: 'merged' });
      assert.equal(batch?.lane.kind, 'brewing');
    });

    it('records the end of that pull request while the batch is Stuck in the fix too (ADR 0219)', async () => {
      const [sentBack] = fixRound('1-1', firstHead, secondHead, 2, pullRequest);
      assert.equal(sentBack?.type === 'step.scheduled' && sentBack.route?.why, 'pull_request');
      store.replay([
        ...openedOnTap('1-1', 'half', firstHead, pullRequest),
        checksFinished('1-1', firstHead, undefined, pullRequest),
        ...(sentBack === undefined ? [] : [sentBack]),
        {
          type: 'batch.stuck',
          batchId: '1-1',
          reason: { kind: 'deadline_passed', stepId: 'plan', deadlineAt: now.toISOString() },
          options: ['retry', 'skip', 'recipe', 'rewind', 'cancel'],
          remindAt: now.toISOString(),
        },
      ]);
      log = createCommandLog({ store, recipes });
      const { tracker } = fakeTracker({ [web]: [], [api]: [] }, { [pullRequest]: 'closed' });
      await intake(tracker).poll();
      const batch = log.state().batches.get('1-1');
      assert.deepStrictEqual(batch?.pullRequestEnds, { [pullRequest]: 'closed' });
      assert.equal(batch?.lane.kind, 'stuck');
    });

    it('checks the open pull requests against their bases after it records the ends (ADR 0198)', async () => {
      onTap();
      for (const [key, result] of [
        [pushKey('web-7'), { branch: 'foedrum/x/acme.web', commit: 'a'.repeat(40), from: 'start' }],
        [pullRequestKey('web-7'), pullRequest],
      ] as const) {
        accept({
          kind: 'record',
          event: { type: 'effect.applied', key: effectKey.encode(key), result },
        });
      }
      const calls: string[] = [];
      let tip = 'c'.repeat(40);
      const bases: IntakeOptions['bases'] = [
        {
          repo: web,
          base: 'main',
          tip: async () => {
            calls.push('tip');
            return tip;
          },
          mergeTree: async () => {
            calls.push('merge-tree');
            return { kind: 'clean' };
          },
          branchTip: async () => 'a'.repeat(40),
        },
      ];
      const { tracker, pullRequests } = fakeTracker(
        { [web]: [], [api]: [] },
        { [pullRequest]: 'open' },
      );
      const polling = intake(tracker, { bases });
      await polling.poll();
      assert.deepStrictEqual(calls, ['tip', 'merge-tree']);
      assert.equal(log.state().batches.get('web-7')?.baseChecks?.length, 1);
      // Merged in the next pass, and the base moved: the end is recorded first, so no check runs.
      pullRequests[pullRequest] = 'merged';
      tip = 'd'.repeat(40);
      await polling.poll();
      assert.deepStrictEqual(ends(), { [pullRequest]: 'merged' });
      assert.deepStrictEqual(calls, ['tip', 'merge-tree']);
    });

    it('checks the open pull requests against each other after their bases (ADR 0230)', async () => {
      const other = 'https://github.com/acme/web/pull/13';
      store.replay([
        ...openedOnTap('1-1', 'half', firstHead, pullRequest),
        ...openedOnTap('1-2', 'half', secondHead, other),
      ]);
      log = createCommandLog({ store, recipes });
      const calls: string[] = [];
      const bases: IntakeOptions['bases'] = [
        {
          repo: web,
          base: 'main',
          tip: async () => 'e'.repeat(40),
          mergeTree: async (one, two) => {
            calls.push(`merge-tree ${one.slice(0, 1)} ${two.slice(0, 1)}`);
            return two === secondHead
              ? { kind: 'conflicts', files: ['app.ts'] }
              : { kind: 'clean' };
          },
          branchTip: async (branch) => (branch.includes('1-1') ? firstHead : secondHead),
        },
      ];
      const { tracker } = fakeTracker(
        { [web]: [], [api]: [] },
        { [pullRequest]: 'open', [other]: 'open' },
      );
      await intake(tracker, { bases }).poll();
      assert.deepStrictEqual(calls, ['merge-tree c e', 'merge-tree d e', 'merge-tree c d']);
      assert.deepStrictEqual(log.state().batches.get('1-2')?.pairChecks, {
        [pullRequest]: {
          pullRequest: other,
          head: secondHead,
          otherHead: firstHead,
          conflicts: ['app.ts'],
        },
      });
    });

    it('reads the checks on the open pull requests after it records the ends, and reports a failed read (ADR 0213)', async () => {
      onTap();
      for (const [key, result] of [
        [pushKey('web-7'), { branch: 'foedrum/x/acme.web', commit: 'a'.repeat(40), from: 'start' }],
        [pullRequestKey('web-7'), pullRequest],
      ] as const) {
        accept({
          kind: 'record',
          event: { type: 'effect.applied', key: effectKey.encode(key), result },
        });
      }
      const calls: string[] = [];
      let checks: Error | undefined = new Error('502 reading checks');
      const reader: IntakeOptions['checks'] = {
        head: async () => {
          calls.push('head');
          return 'a'.repeat(40);
        },
        checks: async () => {
          calls.push('checks');
          if (checks !== undefined) throw checks;
          return [{ name: 'test', kind: 'check_run' }];
        },
        log: async () => {
          throw new Error('a running check has no log to read');
        },
      };
      const { tracker, pullRequests } = fakeTracker(
        { [web]: [], [api]: [] },
        { [pullRequest]: 'open' },
      );
      const polling = intake(tracker, { checks: reader });
      await polling.poll();
      assert.deepStrictEqual(
        notices.filter(({ kind }) => kind === 'failed'),
        [{ kind: 'failed', what: `reading the checks of ${pullRequest}`, error: checks }],
      );
      checks = undefined;
      await polling.poll();
      assert.equal(
        log.state().batches.get('web-7')?.pullRequestChecks?.[pullRequest]?.kind,
        'pending',
      );
      // Merged in the next pass: the end is recorded first, so its checks are read no more.
      pullRequests[pullRequest] = 'merged';
      await polling.poll();
      assert.deepStrictEqual(calls, ['head', 'checks', 'head', 'checks']);
    });
  });

  describe('Brewery issues and routing (ADR 0068)', () => {
    const brewery = 'alice/brewery';
    const labelled = (number: number, fields: Partial<TargetIssue> = {}) =>
      issue(number, { labels: ['recipe:half'], ...fields });
    const lanes = () => batches().map(({ id, lane }) => `${id} ${lane}`);
    const recipeOf = (batchId: string) => log.state().batches.get(batchId)?.recipe;
    const breweryIntake = (tracker: TargetTracker, options: Partial<IntakeOptions> = {}) =>
      intake(tracker, { brewery, ...options });

    it('orders a labelled Brewery issue as <issue>-1 and routes it by its label in the same pass', async () => {
      const { tracker } = fakeTracker({ [brewery]: [labelled(12)], [web]: [], [api]: [] });
      await breweryIntake(tracker).poll();
      assert.deepStrictEqual(lanes(), ['12-1 brewing']);
      assert.deepStrictEqual(recipeOf('12-1'), {
        name: 'half',
        reason: 'the label recipe:half',
        source: 'label',
      });
      assert.deepStrictEqual(notices, [
        { kind: 'ordered', repo: brewery, issue: 12, batchId: '12-1' },
        { kind: 'routed', batchId: '12-1', recipe: 'half' },
      ]);
    });

    it('orders only open issues an allow-listed user opened with a recipe label, never twice', async () => {
      accept({ kind: 'order', batchId: '5-1', order: { issue: 5 } });
      accept({ kind: 'cancel', batchId: '5-1', by: 'alice', via: 'terminal' });
      const { tracker } = fakeTracker({
        [brewery]: [
          labelled(1, { state: 'closed' }),
          labelled(2, { pullRequest: true }),
          issue(3, { labels: ['bug'] }),
          labelled(4, { author: 'mallory' }),
          labelled(5),
          labelled(6, { labels: ['Recipe:half'], author: 'Bob' }),
        ],
        [web]: [],
        [api]: [],
      });
      await breweryIntake(tracker).poll();
      assert.deepStrictEqual(lanes(), ['5-1 cancelled', '6-1 brewing']);
    });

    it('never orders the Brewery issue that is the order of a claimed issue, labelled or not (ADR 0144)', async () => {
      accept({ kind: 'order', batchId: 'web-7', order: { issue: 7, repo: web } });
      accept({
        kind: 'record',
        event: { type: 'effect.applied', key: '["web-7","order.issue"]', result: 12 },
      });
      const { tracker } = fakeTracker({
        [brewery]: [labelled(12), labelled(13)],
        [web]: [],
        [api]: [],
      });
      await breweryIntake(tracker).poll();
      assert.deepStrictEqual(
        batches().map(({ id }) => id),
        ['web-7', '13-1'],
      );
    });

    it('orders Brewery issues and target issues together by arrival, within the free capacity (ADR 0208)', async () => {
      const { tracker } = fakeTracker({
        [brewery]: [labelled(12), labelled(13)],
        [web]: [issue(7), issue(8)],
        [api]: [],
      });
      await breweryIntake(tracker, { capacity: 3 }).poll();
      assert.deepStrictEqual(
        batches().map(({ id }) => id),
        ['web-7', 'web-8', '12-1'],
      );
    });

    it('orders and claims nothing while pause --all holds the Brewery, and still routes (ADR 0202)', async () => {
      accept({ kind: 'order', batchId: '12-1', order: { issue: 12 } });
      accept({ kind: 'pause', by: 'alice', via: 'terminal' });
      const { tracker } = fakeTracker({
        [brewery]: [labelled(12), labelled(13)],
        [web]: [issue(7)],
        [api]: [],
      });
      await breweryIntake(tracker).poll();
      assert.deepStrictEqual(lanes(), ['12-1 brewing']);
      assert.equal(github.refs.size, 0);
      accept({ kind: 'continue', by: 'alice', via: 'terminal' });
      await breweryIntake(tracker).poll();
      // web#7 came before #13 (ADR 0208).
      assert.deepStrictEqual(lanes(), ['12-1 brewing', 'web-7 ordered', '13-1 brewing']);
    });

    it('orders as before while only one order is paused (ADR 0202)', async () => {
      accept({ kind: 'order', batchId: '12-1', order: { issue: 12 } });
      accept({ kind: 'pause', order: { issue: 12 }, by: 'alice', via: 'terminal' });
      const { tracker } = fakeTracker({
        [brewery]: [labelled(12), labelled(13)],
        [web]: [issue(7)],
        [api]: [],
      });
      await breweryIntake(tracker).poll();
      assert.deepStrictEqual(lanes(), ['12-1 brewing', 'web-7 ordered', '13-1 brewing']);
    });

    it('routes an Ordered batch it did not order in this pass: a killed pass left it, or a retry', async () => {
      accept({ kind: 'order', batchId: '12-1', order: { issue: 12 } });
      accept({ kind: 'order', batchId: '13-1', order: { issue: 13 } });
      const later = new Date(now.getTime() + 2 * 3_600_000);
      assert.equal(log.issue({ kind: 'unrouted', batchId: '13-1' }, later).kind, 'accepted');
      assert.equal(
        log.issue({ kind: 'retry', batchId: '13-1', by: 'alice', via: 'terminal' }, later).kind,
        'accepted',
      );
      const { tracker } = fakeTracker({
        [brewery]: [labelled(12), labelled(13)],
        [web]: [],
        [api]: [],
      });
      await breweryIntake(tracker, { clock: () => later }).poll();
      assert.deepStrictEqual(lanes(), ['12-1 brewing', '13-1 brewing']);
    });

    /** Records that the driver opened the Brewery issue `order` for the claimed batch (ADR 0144). */
    const opened = (batchId: string, order: number): void =>
      accept({
        kind: 'record',
        event: { type: 'effect.applied', key: `["${batchId}","order.issue"]`, result: order },
      });

    it("routes a claimed batch by its Brewery issue's recipe label, never its target issue's (ADR 0156)", async () => {
      accept({ kind: 'order', batchId: 'web-7', order: { issue: 7, repo: web } });
      opened('web-7', 12);
      const { tracker } = fakeTracker({
        [brewery]: [issue(12, { labels: ['recipe:nip'] })],
        [web]: [issue(7, { labels: ['foedrum', 'recipe:other'] })],
        [api]: [],
      });
      await breweryIntake(tracker).poll();
      assert.deepStrictEqual(lanes(), ['web-7 brewing']);
      assert.deepStrictEqual(recipeOf('web-7'), {
        name: 'nip',
        reason: 'the label recipe:nip',
        source: 'label',
      });
    });

    it('leaves a claimed batch Ordered until its Brewery issue is recorded, whatever its target issue carries', async () => {
      accept({ kind: 'order', batchId: 'web-7', order: { issue: 7, repo: web } });
      const routeBy = log.state().batches.get('web-7')?.lane;
      // Brewery issue #7 is no order of web-7, though it has the target issue's number.
      const { tracker } = fakeTracker({
        [brewery]: [issue(7, { labels: ['recipe:nip'], author: 'mallory' })],
        [web]: [issue(7, { labels: ['foedrum', 'recipe:half'] })],
        [api]: [],
      });
      await breweryIntake(tracker).poll();
      assert.deepStrictEqual(lanes(), ['web-7 ordered']);
      assert.deepStrictEqual(log.state().batches.get('web-7')?.lane, routeBy);
      assert.deepStrictEqual(notices, []);
    });

    it('reports a claimed batch whose Brewery issue carries two recipe labels, naming that issue', async () => {
      accept({ kind: 'order', batchId: 'web-7', order: { issue: 7, repo: web } });
      opened('web-7', 12);
      const { tracker } = fakeTracker({
        [brewery]: [issue(12, { labels: ['recipe:half', 'recipe:pint'] })],
        [web]: [issue(7)],
        [api]: [],
      });
      await breweryIntake(tracker).poll();
      assert.deepStrictEqual(lanes(), ['web-7 ordered']);
      assert.deepStrictEqual(notices, [
        {
          kind: 'unrouted',
          batchId: 'web-7',
          reason: 'its issue #12 carries recipe:half and recipe:pint; give it one recipe label',
        },
      ]);
    });

    it('routes a claimed issue ordered again by the Brewery issue an earlier batch of it opened', async () => {
      accept({ kind: 'order', batchId: 'web-7', order: { issue: 7, repo: web } });
      opened('web-7', 12);
      accept({ kind: 'cancel', batchId: 'web-7', by: 'alice', via: 'terminal' });
      // The cancel's release, applied by the driver, lets the issue be ordered again (ADR 0105).
      for (const effect of ['release.label', 'release.comment', 'release.ref']) {
        accept({
          kind: 'record',
          event: { type: 'effect.applied', key: `["web-7","${effect}"]`, result: null },
        });
      }
      accept({ kind: 'order', batchId: 'web-7-2', order: { issue: 7, repo: web } });
      const { tracker } = fakeTracker({
        [brewery]: [issue(12, { labels: ['recipe:nip'] })],
        [web]: [],
        [api]: [],
      });
      await breweryIntake(tracker).poll();
      assert.equal(recipeOf('web-7-2')?.name, 'nip');
    });

    it('orders the oldest Brewery issue first, whatever order the listing gives', async () => {
      const { tracker } = fakeTracker({
        [brewery]: [labelled(13), labelled(12)],
        [web]: [],
        [api]: [],
      });
      await breweryIntake(tracker, { capacity: 1 }).poll();
      assert.deepStrictEqual(lanes(), ['12-1 brewing']);
    });

    it('lists no repository it can neither order from nor route in', async () => {
      // Its one place is taken by a Brewing batch, and nothing waits to be routed.
      const first = fakeTracker({ [brewery]: [labelled(12)], [web]: [], [api]: [] });
      await breweryIntake(first.tracker, { capacity: 1 }).poll();
      assert.deepStrictEqual(lanes(), ['12-1 brewing']);
      const { tracker, asked } = fakeTracker({ [brewery]: [labelled(13)], [web]: [], [api]: [] });
      await breweryIntake(tracker, { capacity: 1 }).poll();
      assert.deepStrictEqual(asked, []);
      // A claimed batch is routed by its Brewery issue: nothing is listed for it until that is
      // recorded, then only the Brewery is, never its target repository (ADR 0156).
      accept({ kind: 'order', batchId: 'web-7', order: { issue: 7, repo: web } });
      const unopened = fakeTracker({ [brewery]: [], [web]: [issue(7)], [api]: [] });
      await breweryIntake(unopened.tracker, { capacity: 1 }).poll();
      assert.deepStrictEqual(unopened.asked, []);
      opened('web-7', 14);
      // Its Brewery issue #14 is not listed (a person closed it): it waits, and Brewery issue #7,
      // with its target issue's number, never routes it.
      const routing = fakeTracker({
        [brewery]: [issue(7, { labels: ['recipe:half'], author: 'mallory' })],
        [web]: [issue(7)],
        [api]: [],
      });
      await breweryIntake(routing.tracker, { capacity: 1 }).poll();
      assert.deepStrictEqual(routing.asked, [`issues ${brewery}`]);
      assert.deepStrictEqual(lanes(), ['12-1 brewing', 'web-7 ordered']);
      assert.deepStrictEqual(notices, [
        { kind: 'ordered', repo: brewery, issue: 12, batchId: '12-1' },
        { kind: 'routed', batchId: '12-1', recipe: 'half' },
      ]);
    });

    it("lists the Brewery without free capacity for one of the Brewery's own Ordered batches alone", async () => {
      accept({ kind: 'order', batchId: '12-1', order: { issue: 12 } });
      const { tracker, asked } = fakeTracker({ [brewery]: [labelled(12)], [web]: [], [api]: [] });
      await breweryIntake(tracker, { capacity: 1 }).poll();
      assert.deepStrictEqual(asked, [`issues ${brewery}`]);
      assert.deepStrictEqual(lanes(), ['12-1 brewing']);
    });

    it("routes a claimed batch whose target issue no longer passes its repository's filter, or is gone from it", async () => {
      accept({ kind: 'order', batchId: 'web-7', order: { issue: 7, repo: web } });
      accept({ kind: 'order', batchId: 'web-8', order: { issue: 8, repo: web } });
      opened('web-7', 12);
      opened('web-8', 13);
      const { tracker } = fakeTracker({
        [brewery]: [issue(12, { labels: ['recipe:half'] }), issue(13, { labels: ['recipe:half'] })],
        [web]: [issue(7, { labels: [] })],
        [api]: [],
      });
      await breweryIntake(tracker).poll();
      assert.deepStrictEqual(lanes(), ['web-7 brewing', 'web-8 brewing']);
    });

    it('routes without free capacity: an Ordered batch already holds its place', async () => {
      accept({ kind: 'order', batchId: '12-1', order: { issue: 12 } });
      accept({ kind: 'order', batchId: 'web-7', order: { issue: 7, repo: web } });
      opened('web-7', 13);
      const { tracker } = fakeTracker({
        [brewery]: [labelled(12), labelled(13), labelled(14)],
        [web]: [issue(7), issue(8)],
        [api]: [issue(2)],
      });
      await breweryIntake(tracker, { capacity: 2 }).poll();
      assert.deepStrictEqual(lanes(), ['12-1 brewing', 'web-7 brewing']);
    });

    it('reports once a batch it cannot route: two recipe labels, or a recipe the Brewery lacks', async () => {
      const { tracker } = fakeTracker({
        [brewery]: [
          labelled(12, { labels: ['recipe:half', 'recipe:pint'] }),
          labelled(13, { labels: ['recipe:pint'] }),
        ],
        [web]: [],
        [api]: [],
      });
      const polling = breweryIntake(tracker);
      await polling.poll();
      await polling.poll();
      assert.deepStrictEqual(lanes(), ['12-1 ordered', '13-1 ordered']);
      const unrouted = notices.flatMap((notice) => (notice.kind === 'unrouted' ? [notice] : []));
      assert.deepStrictEqual(
        unrouted.map(({ batchId }) => batchId),
        ['12-1', '13-1'],
      );
      assert.match(unrouted[0]?.reason ?? '', /recipe:half and recipe:pint/);
      assert.match(unrouted[1]?.reason ?? '', /pint/);
    });

    it('never follows a label changed after routing', async () => {
      const first = fakeTracker({ [brewery]: [labelled(12)], [web]: [], [api]: [] });
      await breweryIntake(first.tracker).poll();
      const relabelled = fakeTracker({
        [brewery]: [labelled(12, { labels: ['recipe:other'] })],
        [web]: [],
        [api]: [],
      });
      const before = store.lastEventId();
      await breweryIntake(relabelled.tracker).poll();
      assert.equal(store.lastEventId(), before);
      assert.equal(recipeOf('12-1')?.name, 'half');
    });

    it('reports a Brewery it cannot list, and goes on with the target repositories', async () => {
      const { tracker } = fakeTracker({ [web]: [issue(7)], [api]: [] });
      await breweryIntake(tracker).poll();
      assert.deepStrictEqual(lanes(), ['web-7 ordered']);
      const failed = notices.find((notice) => notice.kind === 'failed');
      assert.equal(failed?.kind === 'failed' ? failed.what : '', `listing ${brewery}`);
    });

    it('leaves a batch without a recipe label Ordered for its deadline, without a notice', async () => {
      accept({ kind: 'order', batchId: 'web-7', order: { issue: 7, repo: web } });
      const { tracker } = fakeTracker({ [brewery]: [], [web]: [issue(7)], [api]: [] });
      await breweryIntake(tracker, { capacity: 1 }).poll();
      assert.deepStrictEqual(lanes(), ['web-7 ordered']);
      assert.deepStrictEqual(notices, []);
    });

    it('routes nothing once the pass is past its deadline', async () => {
      accept({ kind: 'order', batchId: '12-1', order: { issue: 12 } });
      // The Brewery's listing answers only once the test lets it, after the pass was given up.
      let release = (): void => {};
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let answered = (): void => {};
      const listed = new Promise<void>((resolve) => {
        answered = resolve;
      });
      const tracker: TargetTracker = {
        issues: async (repo) => {
          if (repo !== brewery) return [];
          await released;
          answered();
          return [labelled(12)];
        },
        pullRequest: async () => 'open',
      };
      await breweryIntake(tracker, { deadlineMs: 1 }).poll();
      release();
      await listed;
      // What the dead pass does with the late listing settles in the next turns.
      for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setImmediate(resolve));
      assert.deepStrictEqual(lanes(), ['12-1 ordered']);
    });

    it('never orders a sub-order: its decomposition does', async () => {
      accept({ kind: 'order', batchId: '1-1', order: { issue: 1 } });
      accept({
        kind: 'record',
        event: {
          type: 'order.decomposed',
          batchId: '1-1',
          subOrders: [{ issue: 2, repo: web }],
          dependencies: [],
        },
      });
      const { tracker } = fakeTracker({ [brewery]: [labelled(2)], [web]: [], [api]: [] });
      await breweryIntake(tracker).poll();
      assert.deepStrictEqual(lanes(), ['1-1 ordered']);
    });
    it('lists the Brewery with no filter, and with the pass signal', async () => {
      const calls: [string, unknown, boolean][] = [];
      const tracker: TargetTracker = {
        issues: async (repo, filter, signal) => {
          calls.push([repo, filter, signal instanceof AbortSignal]);
          return [];
        },
        pullRequest: async () => 'open',
      };
      await breweryIntake(tracker).poll();
      assert.deepStrictEqual(calls[0], [brewery, undefined, true]);
    });
  });
});

describe('freeCapacity', () => {
  it('is the capacity less the batches that are Ordered or Brewing', () => {
    const store = openSqliteEventStore(':memory:');
    try {
      const log = createCommandLog({ store, recipes });
      const accept = (command: Parameters<CommandLog['issue']>[0]): void =>
        assert.equal(log.issue(command, now).kind, 'accepted');
      for (const n of [1, 2, 3]) accept({ kind: 'order', batchId: `${n}-1`, order: { issue: n } });
      accept({ kind: 'route', batchId: '2-1', recipe: 'half', reason: 'label', source: 'label' });
      accept({ kind: 'cancel', batchId: '3-1', by: 'alice', via: 'terminal' });
      assert.equal(freeCapacity(log.state(), 4), 2);
      assert.equal(freeCapacity(log.state(), 1), 0);
    } finally {
      store.close();
    }
  });

  it('leaves out the batches that are Stuck, Conditioning, On Tap or cancelled', () => {
    const store = openSqliteEventStore(':memory:');
    try {
      const log = createCommandLog({ store, recipes });
      const accept = (command: Parameters<CommandLog['issue']>[0], at = now): void =>
        assert.equal(log.issue(command, at).kind, 'accepted');
      for (const n of [1, 2, 3, 4, 5])
        accept({ kind: 'order', batchId: `${n}-1`, order: { issue: n } });
      // 1-1 Ordered, 2-1 Stuck on routing, 3-1 Conditioning, 4-1 On Tap, 5-1 Brewing.
      accept({ kind: 'unrouted', batchId: '2-1' }, new Date('2026-10-16T11:00:00.000Z'));
      accept({ kind: 'wait', batchId: '3-1', on: { kind: 'sibling', batchId: '1-1' } });
      accept({ kind: 'route', batchId: '4-1', recipe: 'half', reason: 'label', source: 'label' });
      const ref = { batchId: '4-1', stepId: 'plan', attempt: 1 };
      accept({ kind: 'record', event: { type: 'step.started', ...ref } });
      accept({ kind: 'finish', ...ref, ending: succeeded });
      accept({ kind: 'route', batchId: '5-1', recipe: 'half', reason: 'label', source: 'label' });
      const lanes = [...log.state().batches.values()].map(({ lane }) => lane.kind);
      assert.deepStrictEqual(lanes, ['ordered', 'stuck', 'conditioning', 'on_tap', 'brewing']);
      assert.equal(freeCapacity(log.state(), 5), 3);
    } finally {
      store.close();
    }
  });

  for (const capacity of [-1, 1.5, Number.NaN]) {
    it(`refuses a capacity of ${capacity}`, () => {
      const store = openSqliteEventStore(':memory:');
      try {
        const log = createCommandLog({ store, recipes });
        assert.throws(() => freeCapacity(log.state(), capacity), /capacity must be/);
      } finally {
        store.close();
      }
    });
  }
});

describe('intakeRepositories', () => {
  it('lists the repositories with an intake filter, with their alias, in config order', () => {
    const checks = { build: null, typecheck: null, lint: null, format: null, test: null };
    const config = BreweryConfig.parse({
      repositories: {
        'acme/web': { checks, alias: 'web', intake: { labels: ['foedrum'], milestone: 'v2' } },
        'acme/docs': { checks, alias: 'docs' },
        'acme/api': { checks, alias: 'api', intake: { labels: ['ready'] } },
      },
    });
    assert.deepStrictEqual(intakeRepositories(config), [
      { repo: 'acme/web', alias: 'web', filter: { labels: ['foedrum'], milestone: 'v2' } },
      { repo: 'acme/api', alias: 'api', filter: { labels: ['ready'] } },
    ]);
  });
});
