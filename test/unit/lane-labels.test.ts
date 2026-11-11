// The state labels of a batch of a Brewery issue (ADR 0154, ADR 0379): one `foedrum:<state>` label at a
// time on its issue, set through the ledger by a driver as the status comment is (ADR 0072), with a
// fake of the labels host. Nothing reaches GitHub (ADR 0021).

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { type BatchState, stateLine } from '../../src/engine/batch-state.ts';
import { type CommandLog, createCommandLog } from '../../src/engine/command-log.ts';
import type { Ending } from '../../src/engine/decide.ts';
import { type Driver, type DriverNotice, openDriver } from '../../src/engine/driver.ts';
import { effectKey } from '../../src/engine/effect-key.ts';
import type { EventStore } from '../../src/engine/event-store.ts';
import { fold } from '../../src/engine/fold.ts';
import {
  type LaneLabelHost,
  laneLabelEffects,
  laneLabels,
  stateLabel,
} from '../../src/engine/lane-labels.ts';
import { pullRequestKey } from '../../src/engine/pull-request.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import type { Event } from '../../src/schemas/events.ts';
import { defaultLimits } from '../helpers/brewing.ts';
import { fakeLock } from '../helpers/fake-lock.ts';
import { fakeRecipe, fakeRecipes } from '../helpers/fake-recipes.ts';

const at = '2026-10-23T09:00:00.000Z';
const brewery = 'alice/brewery';
const pr = 'https://github.com/alice/web/pull/12';
const succeeded: Ending = {
  kind: 'succeeded',
  output: { status: 'done', summary: 'Done', assumptions: [] },
};

/** The labels of a repository and of its issues, and the calls that changed them. */
const fakeLabels = () => {
  const created = new Set<string>();
  const onIssue = new Map<string, string[]>();
  const calls: string[] = [];
  const of = (repo: string, issue: number): string[] => {
    const key = `${repo}#${issue}`;
    const labels = onIssue.get(key) ?? [];
    onIssue.set(key, labels);
    return labels;
  };
  const host: LaneLabelHost = {
    labels: async (repo, issue) => {
      calls.push('labels');
      return [...of(repo, issue)];
    },
    createLabel: async (repo, label) => {
      calls.push(`create ${label}`);
      created.add(`${repo} ${label}`);
    },
    addLabel: async (repo, issue, label) => {
      calls.push(`add ${label}`);
      assert.ok(created.has(`${repo} ${label}`), `${label} exists in ${repo} before it is added`);
      of(repo, issue).push(label);
    },
    removeLabel: async (repo, issue, label) => {
      calls.push(`remove ${label}`);
      const labels = of(repo, issue);
      labels.splice(labels.indexOf(label), 1);
    },
  };
  return { host, calls, of };
};
describe('stateLabel', () => {
  it('names one label for each state a person reads, and none for a done batch', () => {
    const cases: [BatchState, string | undefined][] = [
      [{ kind: 'queued', by: { kind: 'recipe' } }, 'foedrum:queued'],
      [{ kind: 'queued', by: { kind: 'pause' } }, 'foedrum:queued'],
      [{ kind: 'running' }, 'foedrum:running'],
      [{ kind: 'waiting', for: { kind: 'approve-plan' } }, 'foedrum:approve-plan'],
      [{ kind: 'waiting', for: { kind: 'answer' } }, 'foedrum:answer'],
      [
        { kind: 'waiting', for: { kind: 'review-and-merge', pullRequests: [pr] } },
        'foedrum:review-and-merge',
      ],
      [{ kind: 'waiting', for: { kind: 'open-session' } }, 'foedrum:open-session'],
      [{ kind: 'waiting', for: { kind: 'choose-recipe' } }, 'foedrum:choose-recipe'],
      [{ kind: 'waiting', for: { kind: 'look-at-failure' } }, 'foedrum:look-at-failure'],
      [{ kind: 'done', how: 'merged' }, undefined],
      [{ kind: 'done', how: 'cancelled' }, undefined],
    ];
    for (const [state, label] of cases) assert.equal(stateLabel(state), label, stateLine(state));
    assert.deepEqual(
      [...laneLabels],
      [
        'foedrum:queued',
        'foedrum:running',
        'foedrum:approve-plan',
        'foedrum:answer',
        'foedrum:review-and-merge',
        'foedrum:open-session',
        'foedrum:choose-recipe',
        'foedrum:look-at-failure',
      ],
    );
  });

  it("a split order's label is that of its sub-orders' most pressing state", () => {
    assert.equal(
      stateLabel({
        kind: 'waiting',
        for: { kind: 'review-and-merge', pullRequests: [pr] },
        subOrder: 9,
      }),
      'foedrum:review-and-merge',
    );
  });
});

describe('laneLabelEffects', () => {
  const recipes = fakeRecipes({ nip: fakeRecipe({ steps: ['plan'], pullRequests: [pr] }) });
  let store: EventStore;
  let log: CommandLog;
  let labels: ReturnType<typeof fakeLabels>;
  let notices: DriverNotice[];
  const drivers: Driver[] = [];
  const now = new Date(at);

  beforeEach(() => {
    store = openSqliteEventStore(':memory:');
    log = createCommandLog({ store, recipes });
    labels = fakeLabels();
    notices = [];
  });
  afterEach(() => {
    for (const driver of drivers.splice(0)) driver.close();
    store.close();
  });

  const open = async (): Promise<Driver> => {
    const driver = await openDriver({
      store,
      runner: { start: () => assert.fail('no attempt starts'), progress: () => undefined },
      recipes,
      clock: () => now,
      lock: () => fakeLock('cellar'),
      takes: () => true,
      stateBranch: { flush: async () => ({ kind: 'unchanged' }) },
      limits: () => defaultLimits,
      effects: laneLabelEffects({ brewery, host: labels.host }),
      report: (notice) => notices.push(notice),
    });
    drivers.push(driver);
    return driver;
  };
  const issue = (command: Parameters<CommandLog['issue']>[0]): void => {
    const decision = log.issue(command, now);
    assert.equal(decision.kind, 'accepted', JSON.stringify(decision));
  };
  const order = (): void => issue({ kind: 'order', batchId: '7-1', order: { issue: 7 } });
  const brew = (): void => {
    issue({ kind: 'route', batchId: '7-1', recipe: 'nip', reason: 'label', source: 'label' });
    issue({
      kind: 'record',
      event: { type: 'step.started', batchId: '7-1', stepId: 'plan', attempt: 1 },
    });
  };
  const finish = (): void =>
    issue({ kind: 'finish', batchId: '7-1', stepId: 'plan', attempt: 1, ending: succeeded });
  const revision = (n: number) => store.findEffect({ batchId: '7-1', effect: `label.${n}` });

  it("labels the order's issue with its lane, made in the Brewery first when missing", async () => {
    order();
    const driver = await open();
    await driver.tick();
    assert.deepEqual(labels.of(brewery, 7), ['foedrum:queued']);
    assert.ok(labels.calls.includes('create foedrum:queued'));
    assert.deepEqual(revision(1), { result: { label: 'foedrum:queued' } });
    assert.deepEqual(notices, []);
  });

  it('keeps one lane label at a time as the batch moves, and leaves other labels alone', async () => {
    order();
    labels.of(brewery, 7).push('recipe:nip');
    const driver = await open();
    await driver.tick();
    brew();
    await driver.tick();
    assert.deepEqual(labels.of(brewery, 7), ['recipe:nip', 'foedrum:running']);
    assert.deepEqual(revision(2), { result: { label: 'foedrum:running' } });
    finish();
    await driver.tick();
    assert.deepEqual(labels.of(brewery, 7), ['recipe:nip', 'foedrum:review-and-merge']);
    assert.deepEqual(driver.held(), [], 'the batch is let go once its label shows it on tap');
  });

  it('takes the lane label off a cancelled batch', async () => {
    order();
    const driver = await open();
    await driver.tick();
    issue({ kind: 'cancel', batchId: '7-1', by: 'alice', via: 'terminal' });
    await driver.tick();
    assert.deepEqual(labels.of(brewery, 7), []);
    assert.deepEqual(revision(2), { result: { label: null } });
  });

  it('changes nothing while the lane stays the same', async () => {
    order();
    const driver = await open();
    await driver.tick();
    const calls = labels.calls.length;
    await driver.tick();
    assert.equal(labels.calls.length, calls);
    assert.equal(revision(2), undefined);
  });

  it('finds a label a run before set and was killed before it recorded, and sets nothing again', async () => {
    order();
    labels.of(brewery, 7).push('foedrum:queued');
    const driver = await open();
    await driver.tick();
    assert.deepEqual(revision(1), { result: { label: 'foedrum:queued' } });
    // Found by its one read: apply, which reads again, never ran.
    assert.deepEqual(labels.calls, ['labels']);
  });

  it('takes off a lane label a run before left when it was killed between adding and removing', async () => {
    order();
    const driver = await open();
    await driver.tick();
    // The killed run added brewing and never took ordered off, nor recorded the revision.
    labels.of(brewery, 7).push('foedrum:running');
    brew();
    labels.calls.length = 0;
    await driver.tick();
    assert.deepEqual(labels.of(brewery, 7), ['foedrum:running']);
    assert.deepEqual(
      labels.calls.filter((call) => call !== 'labels'),
      ['remove foedrum:queued'],
    );
    assert.deepEqual(revision(2), { result: { label: 'foedrum:running' } });
  });

  it('reads lane labels without case, as GitHub does', async () => {
    order();
    labels.of(brewery, 7).push('Foedrum:Queued');
    const driver = await open();
    await driver.tick();
    assert.deepEqual(revision(1), { result: { label: 'foedrum:queued' } });
    assert.deepEqual(
      labels.calls.filter((call) => call !== 'labels'),
      [],
    );
    brew();
    await driver.tick();
    assert.deepEqual(labels.of(brewery, 7), ['foedrum:running']);
  });

  it('labels an issue by its latest batch only, never by one it was ordered as before', async () => {
    // 7-1 went on tap before any driver labelled it; the issue was ordered again and cancelled.
    order();
    brew();
    finish();
    issue({ kind: 'order', batchId: '7-2', order: { issue: 7 } });
    issue({ kind: 'cancel', batchId: '7-2', by: 'alice', via: 'terminal' });
    const driver = await open();
    await driver.tick();
    assert.deepEqual(labels.of(brewery, 7), []);
    assert.equal(revision(1), undefined);
    // Cancelled before its first label, 7-2 has none due either.
    assert.equal(store.findEffect({ batchId: '7-2', effect: 'label.1' }), undefined);
  });

  it('a lane change takes the retired foedrum:on-tap off the issue', async () => {
    // An older Foedrum left foedrum:on-tap on the issue of a batch on tap, and recorded it.
    order();
    brew();
    finish();
    store.withTransaction((tx) =>
      tx.recordEffect({ batchId: '7-1', effect: 'label.1' }, { label: 'foedrum:on-tap' }),
    );
    labels.of(brewery, 7).push('foedrum:on-tap');
    const driver = await open();
    await driver.tick();
    // Still on tap: the issue keeps the label it has, and no revision is written on upgrade.
    assert.deepEqual(labels.of(brewery, 7), ['foedrum:on-tap']);
    assert.equal(revision(2), undefined);
    store.withTransaction((tx) =>
      tx.append({
        type: 'batch.stuck',
        batchId: '7-1',
        reason: { kind: 'deadline_passed', stepId: 'plan', deadlineAt: at },
        options: ['retry', 'cancel'],
        remindAt: at,
      }),
    );
    await driver.tick();
    assert.deepEqual(labels.of(brewery, 7), ['foedrum:look-at-failure']);
    assert.ok(labels.calls.includes('remove foedrum:on-tap'));
    assert.deepEqual(revision(2), { result: { label: 'foedrum:look-at-failure' } });
  });

  it('a revision takes off a label this Foedrum retired, such as foedrum:awaiting-merge: regression test', async () => {
    // A driver before ADR 0379 left foedrum:awaiting-merge on the issue, and recorded it.
    order();
    store.withTransaction((tx) =>
      tx.recordEffect({ batchId: '7-1', effect: 'label.1' }, { label: 'foedrum:awaiting-merge' }),
    );
    labels.of(brewery, 7).push('foedrum:awaiting-merge');
    const driver = await open();
    await driver.tick();
    assert.deepEqual(labels.of(brewery, 7), ['foedrum:queued']);
    assert.ok(labels.calls.includes('remove foedrum:awaiting-merge'));
  });

  describe('a claimed target issue (ADR 0144)', () => {
    const order = { issue: 3, repo: 'alice/web' };
    /** The ledger records that `batchId` opened the Brewery issue #20 as its order. */
    const opened = (batchId: string): void =>
      store.withTransaction((tx) => tx.recordEffect({ batchId, effect: 'order.issue' }, 20));
    const untouched = (): void => {
      // Neither the Brewery issue with the target issue's number nor the target issue itself.
      assert.deepEqual(labels.of(brewery, 3), []);
      assert.deepEqual(labels.of('alice/web', 3), []);
    };

    it('labels its Brewery issue with each lane once the batch records it, and nothing before', async () => {
      issue({ kind: 'order', batchId: 'web-3', order });
      const driver = await open();
      await driver.tick();
      assert.deepEqual(labels.calls, [], 'no Brewery issue yet');
      opened('web-3');
      await driver.tick();
      assert.deepEqual(labels.of(brewery, 20), ['foedrum:queued']);
      issue({ kind: 'route', batchId: 'web-3', recipe: 'nip', reason: 'label', source: 'label' });
      issue({
        kind: 'record',
        event: { type: 'step.started', batchId: 'web-3', stepId: 'plan', attempt: 1 },
      });
      await driver.tick();
      assert.deepEqual(labels.of(brewery, 20), ['foedrum:running']);
      issue({ kind: 'finish', batchId: 'web-3', stepId: 'plan', attempt: 1, ending: succeeded });
      await driver.tick();
      assert.deepEqual(labels.of(brewery, 20), ['foedrum:review-and-merge']);
      untouched();
      assert.deepEqual(notices, []);
    });

    it('lets only the latest batch of the issue label the Brewery issue they share', async () => {
      issue({ kind: 'order', batchId: 'web-3', order });
      opened('web-3');
      const driver = await open();
      await driver.tick();
      assert.deepEqual(labels.of(brewery, 20), ['foedrum:queued']);
      issue({ kind: 'cancel', batchId: 'web-3', by: 'alice', via: 'terminal' });
      // Ordered again: web-3's release is the claim effects', which this driver does not apply.
      store.withTransaction((tx) =>
        tx.append({
          type: 'batch.ordered',
          batchId: 'web-3-2',
          order,
          routeBy: '2026-10-23T10:00:00.000Z',
        }),
      );
      await driver.tick();
      // web-3's revision that would take the label off is never due: web-3-2 brews there now.
      assert.equal(store.findEffect({ batchId: 'web-3', effect: 'label.2' }), undefined);
      assert.deepEqual(store.findEffect({ batchId: 'web-3-2', effect: 'label.1' }), {
        result: { label: 'foedrum:queued' },
      });
      assert.deepEqual(labels.of(brewery, 20), ['foedrum:queued']);
      untouched();
    });
  });
});

describe('the lane label of a split order, through its effects (ADR 0293, ADR 0316)', () => {
  const routeBy = '2026-11-01T13:00:00.000Z';
  const lib = 'https://github.com/acme/lib/pull/8';
  const web = 'https://github.com/acme/web/pull/31';
  const subOrder = (id: string, repo: string) => ({
    id,
    title: `Build ${id}`,
    repo,
    size: { lines: 200, mechanism: 'one module' },
    doneWhen: 'its test passes',
    touches: [{ path: 'src/index.ts' }],
    dependencies: [],
    recipe: 'tdd',
    why: 'a test can pin it',
    ready: true,
  });
  /** Order #1, planned by 1-1, approved and split into #2 in acme/lib and #3 in acme/web. */
  const split: Event[] = [
    { type: 'batch.ordered', batchId: '1-1', order: { issue: 1 }, routeBy },
    {
      type: 'batch.recipe_chosen',
      batchId: '1-1',
      recipe: 'mash',
      reason: 'label',
      source: 'label',
    },
    { type: 'step.scheduled', batchId: '1-1', stepId: 'plan', attempt: 1, deadlineAt: routeBy },
    { type: 'step.started', batchId: '1-1', stepId: 'plan', attempt: 1 },
    {
      type: 'step.finished',
      batchId: '1-1',
      stepId: 'plan',
      attempt: 1,
      outcome: {
        kind: 'succeeded',
        output: {
          status: 'done',
          summary: 'A plan',
          assumptions: [],
          subOrders: [subOrder('lib', 'acme/lib'), subOrder('web', 'acme/web')],
        },
      },
    },
    {
      type: 'order.decomposed',
      batchId: '1-1',
      subOrders: [
        { issue: 2, repo: 'acme/lib', entry: 'lib' },
        { issue: 3, repo: 'acme/web', entry: 'web' },
      ],
      dependencies: [],
      plan: { stepId: 'plan', attempt: 1 },
    },
    {
      type: 'batch.approved',
      batchId: '1-1',
      stepId: 'plan',
      attempt: 1,
      plan: '0123456789abcdef',
      by: 'grace',
      via: 'terminal',
      at,
    },
    { type: 'batch.on_tap', batchId: '1-1', pullRequests: [] },
    // Its label so far, as a driver left it.
    {
      type: 'effect.applied',
      key: effectKey.encode({ batchId: '1-1', effect: 'label.1' }),
      result: { label: 'foedrum:sub-orders' },
    },
  ];
  /** Sub-order `issue`'s batch on tap with `url`, and the pull request merged. */
  const merged = (issue: number, url: string): Event[] => [
    {
      type: 'batch.ordered',
      batchId: `${issue}-1`,
      order: { issue },
      parentBatchId: '1-1',
      routeBy,
    },
    { type: 'effect.applied', key: effectKey.encode(pullRequestKey(`${issue}-1`)), result: url },
    { type: 'batch.on_tap', batchId: `${issue}-1`, pullRequests: [url] },
    { type: 'pull_request.ended', batchId: `${issue}-1`, pullRequest: url, state: 'merged' },
  ];
  /** The label the next revision of 1-1 leaves, or none due. */
  const next = async (events: readonly Event[]) => {
    const labels = fakeLabels();
    const effects = laneLabelEffects({ brewery: 'alice/brewery', host: labels.host });
    const [key] = effects.due(fold(events), '1-1');
    return key === undefined ? undefined : effects.target.apply(effectKey.encode(key));
  };

  it('takes the label off once every sub-order merged: regression test', async () => {
    assert.deepEqual(await next([...split, ...merged(2, lib), ...merged(3, web)]), { label: null });
  });

  it('labels the order foedrum:queued while a sub-order waits for those it depends on', async () => {
    assert.deepEqual(await next([...split, ...merged(2, lib)]), { label: 'foedrum:queued' });
  });

  it("labels the order with a brewing sub-order's state", async () => {
    const brewing: Event[] = [
      { type: 'batch.ordered', batchId: '3-1', order: { issue: 3 }, parentBatchId: '1-1', routeBy },
      {
        type: 'batch.recipe_chosen',
        batchId: '3-1',
        recipe: 'tdd',
        reason: 'label',
        source: 'label',
      },
      { type: 'step.scheduled', batchId: '3-1', stepId: 'code', attempt: 1, deadlineAt: routeBy },
      { type: 'step.started', batchId: '3-1', stepId: 'code', attempt: 1 },
    ];
    assert.deepEqual(await next([...split, ...merged(2, lib), ...brewing]), {
      label: 'foedrum:running',
    });
  });
});
