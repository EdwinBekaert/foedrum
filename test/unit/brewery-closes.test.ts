// The close of a Brewery issue whose batch's pull requests merged (ADR 0296): a target
// repository's pull request names no Brewery issue, so the engine closes it, with a comment naming
// what merged, through the ledger.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { breweryCloseEffects } from '../../src/engine/brewery-closes.ts';
import { effectMarker, type IssueMarks } from '../../src/engine/claim-effects.ts';
import { type CommandLog, createCommandLog } from '../../src/engine/command-log.ts';
import type { Ending } from '../../src/engine/decide.ts';
import { type Driver, type DriverNotice, openDriver } from '../../src/engine/driver.ts';
import { effectKey } from '../../src/engine/effect-key.ts';
import type { EventStore } from '../../src/engine/event-store.ts';
import { pullRequestKey } from '../../src/engine/pull-request.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import { defaultLimits } from '../helpers/brewing.ts';
import { type FakeGitHub, fakeGitHub } from '../helpers/fake-github.ts';
import { fakeLock } from '../helpers/fake-lock.ts';
import { fakeRecipe, fakeRecipes } from '../helpers/fake-recipes.ts';

const brewery = 'alice/brewery';
const web = 'https://github.com/acme/web/pull/31';
const lib = 'https://github.com/acme/lib/pull/8';
const now = new Date('2026-11-01T09:00:00.000Z');
const recipes = fakeRecipes({
  one: fakeRecipe({ steps: ['plan'], pullRequests: [web] }),
  two: fakeRecipe({ steps: ['plan'], pullRequests: [web, lib] }),
  none: fakeRecipe({ steps: ['plan'], pullRequests: [] }),
});
const succeeded: Ending = {
  kind: 'succeeded',
  output: { status: 'done', summary: 'Done', assumptions: [] },
};

describe('breweryCloseEffects', () => {
  let store: EventStore;
  let intake: CommandLog;
  let github: FakeGitHub;
  let notices: DriverNotice[];
  const drivers: Driver[] = [];

  beforeEach(() => {
    store = openSqliteEventStore(':memory:');
    intake = createCommandLog({ store, recipes });
    github = fakeGitHub();
    notices = [];
  });
  afterEach(() => {
    for (const driver of drivers.splice(0)) driver.close();
    store.close();
  });

  const open = async (marks: IssueMarks = github.marks('alice')): Promise<Driver> => {
    const driver = await openDriver({
      store,
      runner: { start: () => assert.fail('no attempt starts'), progress: () => undefined },
      recipes,
      clock: () => now,
      lock: () => fakeLock('cellar'),
      takes: () => true,
      stateBranch: { flush: async () => ({ kind: 'unchanged' }) },
      limits: () => defaultLimits,
      effects: breweryCloseEffects({ marks, brewery }),
      report: (notice) => notices.push(notice),
    });
    drivers.push(driver);
    return driver;
  };
  const issue = (command: Parameters<CommandLog['issue']>[0]): void => {
    const decision = intake.issue(command, now);
    assert.equal(decision.kind, 'accepted', JSON.stringify(decision));
  };
  /** Orders the Brewery issue #12 as batch 12-1 and brews it on tap with `recipe`. */
  const onTap = (
    recipe: 'one' | 'two' | 'none',
    batchId = '12-1',
    ordered: { issue: number; repo?: string } = { issue: 12 },
  ): void => {
    issue({ kind: 'order', batchId, order: ordered });
    issue({ kind: 'route', batchId, recipe, reason: 'label', source: 'label' });
    const ref = { batchId, stepId: 'plan', attempt: 1 };
    issue({ kind: 'record', event: { type: 'step.started', ...ref } });
    issue({ kind: 'finish', ...ref, ending: succeeded });
  };
  const ended = (pullRequest: string, state: 'merged' | 'closed', batchId = '12-1'): void =>
    issue({
      kind: 'record',
      event: { type: 'pull_request.ended', batchId, pullRequest, state },
    });
  const order = () => github.issue(brewery, 12);
  const ledger = (effect: string) => store.findEffect({ batchId: '12-1', effect });

  it('closes the Brewery issue once its batch’s pull request merged, with a comment naming it', async () => {
    onTap('one');
    const driver = await open();
    await driver.tick();
    assert.equal(order().state, undefined, 'open while the pull request is');
    assert.equal(order().comments.length, 0);
    ended(web, 'merged');
    await driver.tick();
    assert.equal(order().state, 'closed');
    assert.equal(order().comments.length, 1);
    const [comment] = order().comments;
    assert.equal(comment?.author, 'alice');
    assert.match(comment?.body ?? '', /^Merged as acme\/web#31; Foedrum closes this issue\./);
    const key = effectKey.encode({ batchId: '12-1', effect: 'close.comment' });
    assert.ok(comment?.body.includes(effectMarker(key)), 'the comment carries its key');
    assert.deepStrictEqual(ledger('close.comment'), { result: 1 });
    assert.deepStrictEqual(ledger('close.issue'), { result: null });
    assert.deepStrictEqual(notices, []);
  });

  it('leaves the Brewery issue open when its pull request closed without merging', async () => {
    onTap('one');
    ended(web, 'closed');
    const driver = await open();
    await driver.tick();
    assert.equal(order().state, undefined);
    assert.equal(order().comments.length, 0);
    assert.equal(ledger('close.issue'), undefined);
  });

  it('leaves the Brewery issue open when one of two pull requests merged and the other closed unmerged', async () => {
    onTap('two');
    ended(web, 'merged');
    ended(lib, 'closed');
    const driver = await open();
    await driver.tick();
    assert.equal(order().state, undefined);
    assert.equal(order().comments.length, 0);
    assert.equal(ledger('close.issue'), undefined);
  });

  it('finds the comment and the close a run applied and was killed before it recorded', async () => {
    onTap('one');
    ended(web, 'merged');
    // A killed run had commented and closed the issue; neither is in the ledger.
    const key = effectKey.encode({ batchId: '12-1', effect: 'close.comment' });
    order().comments.push({ author: 'alice', body: `Merged\n\n${effectMarker(key)}` });
    order().state = 'closed';
    const driver = await open();
    await driver.tick();
    assert.equal(order().comments.length, 1);
    assert.equal(github.calls.get('comment'), undefined);
    assert.equal(github.calls.get('setIssueState'), undefined);
    assert.deepStrictEqual(ledger('close.comment'), { result: 1 });
    assert.deepStrictEqual(ledger('close.issue'), { result: null });
  });

  it('posts no comment on a Brewery issue that is closed already, as one a Closes line closed before ADR 0296', async () => {
    onTap('one');
    ended(web, 'merged');
    order().state = 'closed';
    const driver = await open();
    await driver.tick();
    assert.equal(order().comments.length, 0);
    assert.equal(github.calls.get('comment'), undefined);
    assert.deepStrictEqual(ledger('close.comment'), { result: 'closed' });
    assert.deepStrictEqual(ledger('close.issue'), { result: null });
  });

  it('leaves the Brewery issue to its newer batch when the issue was ordered again after a merge', async () => {
    onTap('one');
    ended(web, 'merged');
    // A person reopened #12 and ordered it again; its new batch is brewing.
    issue({
      kind: 'order_again',
      batchId: '12-2',
      order: { issue: 12 },
      by: 'ann',
      via: 'terminal',
    });
    const driver = await open();
    await driver.tick();
    assert.equal(order().state, undefined);
    assert.equal(order().comments.length, 0);
    assert.equal(ledger('close.comment'), undefined);
    assert.equal(ledger('close.issue'), undefined);
  });

  it('ends the close as gone when a person deleted the Brewery issue', async () => {
    onTap('one');
    ended(web, 'merged');
    order().state = 'gone';
    // GitHub answers 410 for a deleted issue's comments as for its state.
    const marks = github.marks('alice');
    const driver = await open({
      ...marks,
      findComment: async () => undefined,
      comment: async () => {
        throw new Error('410 Gone: alice/brewery#12 was deleted');
      },
    });
    await driver.tick();
    assert.deepStrictEqual(ledger('close.comment'), { result: 'gone' });
    assert.deepStrictEqual(ledger('close.issue'), { result: 'gone' });
    assert.equal(github.calls.get('setIssueState'), undefined);
    assert.deepStrictEqual(notices, []);
  });

  it('names each pull request in the comment when every one of them merged', async () => {
    onTap('two');
    ended(web, 'merged');
    ended(lib, 'merged');
    const driver = await open();
    await driver.tick();
    assert.equal(order().state, 'closed');
    assert.match(
      order().comments[0]?.body ?? '',
      /^Merged as acme\/web#31, acme\/lib#8; Foedrum closes this issue\./,
    );
  });

  it('leaves the issue of a batch on tap with no pull request open, as a split order’s own batch', async () => {
    onTap('none');
    const driver = await open();
    await driver.tick();
    assert.equal(ledger('close.comment'), undefined);
    assert.equal(order().state, undefined);
    assert.equal(order().comments.length, 0);
  });

  it('closes a split order’s sub-issue once its batch’s pull request merged (ADR 0285)', async () => {
    const routeBy = '2026-11-01T10:00:00.000Z';
    store.withTransaction((tx) => {
      tx.append({ type: 'batch.ordered', batchId: '1-1', order: { issue: 1 }, routeBy });
      tx.append({
        type: 'order.decomposed',
        batchId: '1-1',
        subOrders: [{ issue: 12, repo: 'acme/web' }],
        dependencies: [],
      });
      tx.append({ type: 'batch.on_tap', batchId: '1-1', pullRequests: [] });
      tx.append({
        type: 'batch.ordered',
        batchId: '12-1',
        order: { issue: 12 },
        parentBatchId: '1-1',
        routeBy,
      });
      // The ledger's open of its pull request, which the order's sub-orders are read by.
      tx.append({
        type: 'effect.applied',
        key: effectKey.encode(pullRequestKey('12-1')),
        result: web,
      });
      tx.append({ type: 'batch.on_tap', batchId: '12-1', pullRequests: [web] });
    });
    ended(web, 'merged');
    const driver = await open();
    await driver.tick();
    assert.equal(order().state, 'closed');
    assert.match(order().comments[0]?.body ?? '', /^Merged as acme\/web#31; /);
    // The order's own issue closes too: its one sub-order merged (ADR 0293).
    assert.equal(github.issue(brewery, 1).state, 'closed');
  });

  it('leaves a claimed batch’s Brewery issue to its claim’s release', async () => {
    onTap('one', 'web-7', { issue: 7, repo: 'acme/web' });
    // The driver opened #13 as the claimed issue's Brewery issue (ADR 0144).
    store.withTransaction((tx) => {
      tx.append({
        type: 'effect.applied',
        key: effectKey.encode({ batchId: 'web-7', effect: 'order.issue' }),
        result: 13,
      });
    });
    ended(web, 'merged', 'web-7');
    const driver = await open();
    await driver.tick();
    assert.equal(store.findEffect({ batchId: 'web-7', effect: 'close.comment' }), undefined);
    assert.equal(store.findEffect({ batchId: 'web-7', effect: 'close.issue' }), undefined);
    assert.equal(github.issue(brewery, 13).comments.length, 0);
    assert.equal(github.issue(brewery, 13).state, undefined);
  });
});
