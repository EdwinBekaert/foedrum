// The lane labels of a batch of a Brewery issue (#406, ADR 0154): one `foedrum:<lane>` label at a
// time on its issue, set through the ledger by a driver as the status comment is (ADR 0072), with a
// fake of the labels host. Nothing reaches GitHub (ADR 0021).

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { type CommandLog, createCommandLog } from '../../src/engine/command-log.ts';
import type { Ending } from '../../src/engine/decide.ts';
import { type Driver, type DriverNotice, openDriver } from '../../src/engine/driver.ts';
import type { EventStore } from '../../src/engine/event-store.ts';
import type { Lane } from '../../src/engine/fold.ts';
import {
  type LaneLabelHost,
  laneLabel,
  laneLabelEffects,
  laneLabels,
} from '../../src/engine/lane-labels.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
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

describe('laneLabel', () => {
  it('names one label for each lane, and none for a cancelled batch', () => {
    const lanes: [Lane, string | undefined][] = [
      [{ kind: 'ordered', routeBy: at }, 'foedrum:ordered'],
      [{ kind: 'brewing' }, 'foedrum:brewing'],
      [
        { kind: 'conditioning', on: { kind: 'merge', pullRequest: pr }, remindAt: at },
        'foedrum:conditioning',
      ],
      [
        {
          kind: 'stuck',
          reason: { kind: 'waiting_for_session', stepId: 'plan' },
          options: ['retry'],
          remindAt: at,
        },
        'foedrum:stuck',
      ],
      [{ kind: 'on_tap', pullRequests: [pr] }, 'foedrum:on-tap'],
      [{ kind: 'cancelled', by: 'alice', via: 'terminal' }, undefined],
    ];
    for (const [lane, label] of lanes) assert.equal(laneLabel(lane), label, lane.kind);
    assert.deepEqual(
      [...laneLabels],
      [
        'foedrum:ordered',
        'foedrum:brewing',
        'foedrum:conditioning',
        'foedrum:stuck',
        'foedrum:on-tap',
      ],
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
    assert.deepEqual(labels.of(brewery, 7), ['foedrum:ordered']);
    assert.ok(labels.calls.includes('create foedrum:ordered'));
    assert.deepEqual(revision(1), { result: { label: 'foedrum:ordered' } });
    assert.deepEqual(notices, []);
  });

  it('keeps one lane label at a time as the batch moves, and leaves other labels alone', async () => {
    order();
    labels.of(brewery, 7).push('recipe:nip');
    const driver = await open();
    await driver.tick();
    brew();
    await driver.tick();
    assert.deepEqual(labels.of(brewery, 7), ['recipe:nip', 'foedrum:brewing']);
    assert.deepEqual(revision(2), { result: { label: 'foedrum:brewing' } });
    finish();
    await driver.tick();
    assert.deepEqual(labels.of(brewery, 7), ['recipe:nip', 'foedrum:on-tap']);
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
    labels.of(brewery, 7).push('foedrum:ordered');
    const driver = await open();
    await driver.tick();
    assert.deepEqual(revision(1), { result: { label: 'foedrum:ordered' } });
    // Found by its one read: apply, which reads again, never ran.
    assert.deepEqual(labels.calls, ['labels']);
  });

  it('takes off a lane label a run before left when it was killed between adding and removing', async () => {
    order();
    const driver = await open();
    await driver.tick();
    // The killed run added brewing and never took ordered off, nor recorded the revision.
    labels.of(brewery, 7).push('foedrum:brewing');
    brew();
    labels.calls.length = 0;
    await driver.tick();
    assert.deepEqual(labels.of(brewery, 7), ['foedrum:brewing']);
    assert.deepEqual(
      labels.calls.filter((call) => call !== 'labels'),
      ['remove foedrum:ordered'],
    );
    assert.deepEqual(revision(2), { result: { label: 'foedrum:brewing' } });
  });

  it('reads lane labels without case, as GitHub does', async () => {
    order();
    labels.of(brewery, 7).push('Foedrum:Ordered');
    const driver = await open();
    await driver.tick();
    assert.deepEqual(revision(1), { result: { label: 'foedrum:ordered' } });
    assert.deepEqual(
      labels.calls.filter((call) => call !== 'labels'),
      [],
    );
    brew();
    await driver.tick();
    assert.deepEqual(labels.of(brewery, 7), ['foedrum:brewing']);
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
      assert.deepEqual(labels.of(brewery, 20), ['foedrum:ordered']);
      issue({ kind: 'route', batchId: 'web-3', recipe: 'nip', reason: 'label', source: 'label' });
      issue({
        kind: 'record',
        event: { type: 'step.started', batchId: 'web-3', stepId: 'plan', attempt: 1 },
      });
      await driver.tick();
      assert.deepEqual(labels.of(brewery, 20), ['foedrum:brewing']);
      issue({ kind: 'finish', batchId: 'web-3', stepId: 'plan', attempt: 1, ending: succeeded });
      await driver.tick();
      assert.deepEqual(labels.of(brewery, 20), ['foedrum:on-tap']);
      untouched();
      assert.deepEqual(notices, []);
    });

    it('lets only the latest batch of the issue label the Brewery issue they share', async () => {
      issue({ kind: 'order', batchId: 'web-3', order });
      opened('web-3');
      const driver = await open();
      await driver.tick();
      assert.deepEqual(labels.of(brewery, 20), ['foedrum:ordered']);
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
        result: { label: 'foedrum:ordered' },
      });
      assert.deepEqual(labels.of(brewery, 20), ['foedrum:ordered']);
      untouched();
    });
  });
});
