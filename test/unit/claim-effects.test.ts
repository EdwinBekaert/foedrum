// The claim marks and the release of a target-repository issue as the driver's effects (ADR 0043,
// #103): due because of recorded events, the end of each pull request included, applied once
// through the ledger while the driver holds the batch, each within its deadline (#130).

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { claimEffects, effectMarker, type IssueMarks } from '../../src/engine/claim-effects.ts';
import { type CommandLog, createCommandLog } from '../../src/engine/command-log.ts';
import type { Ending } from '../../src/engine/decide.ts';
import { type Driver, type DriverNotice, openDriver } from '../../src/engine/driver.ts';
import { effectKey } from '../../src/engine/effect-key.ts';
import type { EventStore } from '../../src/engine/event-store.ts';
import { type Claimant, claimLabel } from '../../src/engine/issue-claims.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import { defaultLimits } from '../helpers/brewing.ts';
import { type FakeGitHub, fakeGitHub } from '../helpers/fake-github.ts';
import { fakeLock } from '../helpers/fake-lock.ts';
import { fakeRecipe, fakeRecipes } from '../helpers/fake-recipes.ts';

const repo = 'acme/web';
const merged = 'https://github.com/acme/web/pull/12';
const other = 'https://github.com/acme/web/pull/13';
const now = new Date('2026-10-16T09:00:00.000Z');
const alice: Claimant = { brewery: 'alice/brewery', login: 'alice' };
const recipes = fakeRecipes({
  half: fakeRecipe({ steps: ['plan'], pullRequests: [merged, other] }),
});
const succeeded: Ending = {
  kind: 'succeeded',
  output: { status: 'done', summary: 'Done', assumptions: [] },
};
const record = (brewery: string): string =>
  JSON.stringify({ brewery, issue: 7, claimedAt: now.toISOString() });

describe('claimEffects', () => {
  let store: EventStore;
  let intake: CommandLog;
  let github: FakeGitHub;
  let notices: DriverNotice[];
  const drivers: Driver[] = [];

  beforeEach(() => {
    store = openSqliteEventStore(':memory:');
    intake = createCommandLog({ store, recipes });
    github = fakeGitHub();
    // The intake claimed the issue before it ordered the batch.
    github.setRef(repo, 7, record(alice.brewery));
    notices = [];
  });
  afterEach(() => {
    for (const driver of drivers.splice(0)) driver.close();
    store.close();
  });

  /** A driver that applies the claim effects through `marks`, the fake GitHub by default. */
  const open = async (
    options: { marks?: IssueMarks; deadlineMs?: number } = {},
  ): Promise<Driver> => {
    const { marks = github.marks(alice.login), deadlineMs } = options;
    const driver = await openDriver({
      store,
      runner: { start: () => assert.fail('no attempt starts'), progress: () => undefined },
      recipes,
      clock: () => now,
      lock: () => fakeLock('cellar'),
      takes: () => true,
      stateBranch: { flush: async () => ({ kind: 'unchanged' }) },
      limits: () => defaultLimits,
      effects: claimEffects({
        claimant: alice,
        marks,
        claims: github.host,
        ...(deadlineMs === undefined ? {} : { deadlineMs }),
      }),
      report: (notice) => notices.push(notice),
    });
    drivers.push(driver);
    return driver;
  };

  const issue = (command: Parameters<CommandLog['issue']>[0]): void => {
    const decision = intake.issue(command, now);
    assert.equal(decision.kind, 'accepted', JSON.stringify(decision));
  };
  /** Orders web-7, the batch of acme/web#7. */
  const order = (): void => issue({ kind: 'order', batchId: 'web-7', order: { issue: 7, repo } });
  /** Orders web-7 and brews it on tap, with pull requests `merged` and `other`. */
  const onTap = (): void => {
    order();
    issue({ kind: 'route', batchId: 'web-7', recipe: 'half', reason: 'label', source: 'label' });
    const ref = { batchId: 'web-7', stepId: 'plan', attempt: 1 };
    issue({ kind: 'record', event: { type: 'step.started', ...ref } });
    issue({ kind: 'finish', ...ref, ending: succeeded });
  };
  const ended = (pullRequest: string, state: 'merged' | 'closed'): void =>
    issue({
      kind: 'record',
      event: { type: 'pull_request.ended', batchId: 'web-7', pullRequest, state },
    });
  const marks = () => github.issue(repo, 7);
  const ledger = (effect: string) => store.findEffect({ batchId: 'web-7', effect });

  it('marks the claimed issue: assigned, labelled and a comment naming the Brewery and batch', async () => {
    order();
    const driver = await open();
    await driver.tick();
    assert.deepStrictEqual(marks().assignees, ['alice']);
    assert.deepStrictEqual(marks().labels, [claimLabel]);
    assert.equal(marks().comments.length, 1);
    const [comment] = marks().comments;
    assert.equal(comment?.author, 'alice');
    assert.match(comment?.body ?? '', /`alice\/brewery`.*`web-7`/s);
    assert.match(comment?.body ?? '', /refs\/foedrum\/claims\/issues\/7/);
    const key = effectKey.encode({ batchId: 'web-7', effect: 'claim.comment' });
    assert.ok(comment?.body.includes(effectMarker(key)), 'the comment carries its key');
    assert.deepStrictEqual(notices, []);
  });

  it('records each mark in the ledger, and asks the code host nothing more once it is', async () => {
    order();
    const driver = await open();
    await driver.tick();
    assert.deepStrictEqual(ledger('claim.assignee'), { result: 'alice' });
    assert.deepStrictEqual(ledger('claim.label'), { result: null });
    assert.deepStrictEqual(ledger('claim.comment'), { result: 1 });
    const calls = new Map(github.calls);
    await driver.tick();
    await driver.tick();
    assert.deepStrictEqual(github.calls, calls);
    assert.equal(marks().comments.length, 1);
  });

  it('finds a mark a run before applied and was killed before it recorded', async () => {
    order();
    // A killed run had assigned the issue and commented; neither is in the ledger.
    marks().assignees.push('alice');
    const key = effectKey.encode({ batchId: 'web-7', effect: 'claim.comment' });
    marks().comments.push({ author: 'alice', body: `claimed\n${effectMarker(key)}` });
    const driver = await open();
    await driver.tick();
    assert.deepStrictEqual(marks().assignees, ['alice']);
    assert.equal(marks().comments.length, 1);
    assert.deepStrictEqual(ledger('claim.comment'), { result: 1 });
  });

  it('counts only its own comment with the key, not one someone else planted', async () => {
    order();
    const key = effectKey.encode({ batchId: 'web-7', effect: 'claim.comment' });
    marks().comments.push({ author: 'mallory', body: effectMarker(key) });
    const driver = await open();
    await driver.tick();
    assert.equal(marks().comments.length, 2);
    assert.equal(marks().comments[1]?.author, 'alice');
    assert.deepStrictEqual(ledger('claim.comment'), { result: 2 });
  });

  it('has no effects for a batch of a Brewery issue', async () => {
    issue({ kind: 'order', batchId: '7-1', order: { issue: 7 } });
    const driver = await open();
    await driver.tick();
    assert.deepStrictEqual(marks(), { assignees: [], labels: [], comments: [] });
    assert.deepStrictEqual(driver.held(), []);
  });

  it('keeps the claim while a pull request of the batch on tap has no recorded end', async () => {
    onTap();
    ended(merged, 'merged');
    const driver = await open();
    await driver.tick();
    assert.deepStrictEqual(marks().labels, [claimLabel]);
    assert.equal(github.refs.has(`${repo}#7`), true);
    assert.equal(ledger('release.ref'), undefined);
  });

  it('releases the claim once the recorded ends say every pull request merged', async () => {
    onTap();
    const driver = await open();
    await driver.tick();
    ended(merged, 'merged');
    ended(other, 'merged');
    await driver.tick();
    assert.deepStrictEqual(marks().assignees, ['alice'], 'the assignee stays');
    assert.deepStrictEqual(marks().labels, []);
    assert.match(marks().comments[1]?.body ?? '', /its pull requests were merged\./);
    assert.equal(github.refs.has(`${repo}#7`), false);
    assert.deepStrictEqual(ledger('release.ref'), { result: 'released' });
    assert.deepStrictEqual(driver.held(), [], 'the batch is let go once nothing is due');
    assert.deepStrictEqual(notices, []);
  });

  it('releases the claim of a batch whose pull request was closed, asking to unassign it', async () => {
    onTap();
    ended(merged, 'merged');
    ended(other, 'closed');
    const driver = await open();
    await driver.tick();
    assert.match(
      marks().comments.at(-1)?.body ?? '',
      /a pull request was closed without being merged\. Unassign the issue/,
    );
    assert.equal(github.refs.has(`${repo}#7`), false);
  });

  it('releases the claim of a cancelled batch, leaving a ref that names another Brewery', async () => {
    order();
    const driver = await open();
    await driver.tick();
    issue({ kind: 'cancel', batchId: 'web-7', by: 'alice', via: 'terminal' });
    // Released by hand and claimed by bob's Brewery since.
    github.setRef(repo, 7, record('bob/brewery'));
    await driver.tick();
    assert.match(marks().comments.at(-1)?.body ?? '', /was cancelled\./);
    assert.equal(github.refs.get(`${repo}#7`), record('bob/brewery'));
    assert.deepStrictEqual(ledger('release.ref'), { result: 'not_ours' });
  });

  it('refuses a comment id the code host answered that is no positive integer, recording nothing', async () => {
    order();
    const marksHost = github.marks(alice.login);
    const driver = await open({ marks: { ...marksHost, comment: async () => 0 } });
    await driver.tick();
    assert.equal(ledger('claim.comment'), undefined);
    assert.ok(
      notices.some(
        (notice) =>
          notice.kind === 'effect_failed' &&
          /comment id/.test(String(notice.error)) &&
          notice.key.effect === 'claim.comment',
      ),
    );
  });

  it('hands its deadline to the driver, which holds each effect to it', async () => {
    order();
    // Assigns only after 300 ms, long past the deadline, unless its signal aborts first.
    const hanging: IssueMarks = {
      ...github.marks(alice.login),
      assign: (_repo, _issue, _login, signal) =>
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 300);
          signal?.addEventListener('abort', () => clearTimeout(timer));
        }),
    };
    const effects = claimEffects({
      claimant: alice,
      marks: hanging,
      claims: github.host,
      deadlineMs: 20,
    });
    assert.equal(effects.deadlineMs, 20);
    const driver = await open({ marks: hanging, deadlineMs: 20 });
    await driver.tick();
    assert.equal(ledger('claim.assignee'), undefined);
    assert.match(
      notices[0]?.kind === 'effect_failed' ? String(notices[0].error) : '',
      /\["web-7","claim.assignee"\] took longer than its deadline of 20 ms/,
    );
  });
});
