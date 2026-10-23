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

  describe('the Brewery issue that is its order (ADR 0144)', () => {
    const brewery = alice.brewery;
    const opened = () => github.opened(brewery);
    const orderAgain = (batchId: string): void => {
      github.setRef(repo, 7, record(alice.brewery));
      issue({
        kind: 'order_again',
        batchId,
        order: { issue: 7, repo },
        by: 'ann',
        via: 'terminal',
      });
    };

    it('opens it once, in the Brewery, through the ledger: the title copied, the target issue linked', async () => {
      marks().title = 'Add a dark theme';
      order();
      const driver = await open();
      await driver.tick();
      await driver.tick();
      assert.equal(opened().length, 1);
      const [made] = opened();
      assert.equal(made?.title, 'Add a dark theme');
      assert.equal(made?.author, 'alice');
      assert.match(made?.body ?? '', /acme\/web#7/);
      assert.doesNotMatch(made?.body ?? '', /Add a dark theme/, 'only its title is copied');
      const key = effectKey.encode({ batchId: 'web-7', effect: 'order.issue' });
      assert.ok(made?.body.includes(effectMarker(key)), 'the issue carries its key');
      assert.deepStrictEqual(ledger('order.issue'), { result: made?.number });
      assert.equal(github.issue(repo, 7).comments.length, 1, 'the target issue gets no more');
      assert.deepStrictEqual(notices, []);
    });

    it('finds the one a run before opened and was killed before it recorded', async () => {
      order();
      const key = effectKey.encode({ batchId: 'web-7', effect: 'order.issue' });
      const made = await github.marks('alice').openIssue(brewery, 'Issue 7', effectMarker(key));
      const driver = await open();
      await driver.tick();
      assert.equal(opened().length, 1);
      assert.deepStrictEqual(ledger('order.issue'), { result: made });
    });

    // Which issues count is the code host's findIssue (githubIssueMarks, test/unit/github-marks.test.ts).
    it('opens its own when the code host finds no issue of its own identity with the key', async () => {
      order();
      const key = effectKey.encode({ batchId: 'web-7', effect: 'order.issue' });
      await github.marks('mallory').openIssue(brewery, 'Issue 7', effectMarker(key));
      const driver = await open();
      await driver.tick();
      assert.equal(opened().length, 2);
      assert.deepStrictEqual(ledger('order.issue'), { result: 2 });
    });

    it('refuses an issue number the code host answered that is no positive integer', async () => {
      order();
      const driver = await open({ marks: { ...github.marks('alice'), openIssue: async () => 0 } });
      await driver.tick();
      assert.equal(ledger('order.issue'), undefined);
      assert.ok(
        notices.some(
          (notice) => notice.kind === 'effect_failed' && notice.key.effect === 'order.issue',
        ),
      );
    });

    it('refuses an issue number the code host found that is no positive integer', async () => {
      order();
      const driver = await open({ marks: { ...github.marks('alice'), findIssue: async () => 0 } });
      await driver.tick();
      assert.equal(ledger('order.issue'), undefined);
      assert.ok(
        notices.some(
          (notice) => notice.kind === 'effect_failed' && notice.key.effect === 'order.issue',
        ),
      );
    });

    it('records the close without closing again when a person closed it already', async () => {
      onTap();
      const driver = await open();
      await driver.tick();
      const [made] = opened();
      github.issue(brewery, made?.number ?? 0).state = 'closed';
      ended(merged, 'merged');
      ended(other, 'merged');
      await driver.tick();
      assert.deepStrictEqual(ledger('release.order'), { result: null });
      assert.equal(github.calls.get('setIssueState'), undefined);
    });

    it('releases the claim after a merge when a person deleted the Brewery issue', async () => {
      onTap();
      const driver = await open();
      await driver.tick();
      const [made] = opened();
      github.issue(brewery, made?.number ?? 0).state = 'gone';
      ended(merged, 'merged');
      ended(other, 'merged');
      await driver.tick();
      assert.deepStrictEqual(ledger('release.order'), { result: 'gone' });
      assert.equal(github.refs.has(`${repo}#7`), false, 'the ref goes all the same');
      assert.deepStrictEqual(notices, []);
    });

    it('orders the issue again when a person deleted the Brewery issue a merge closed', async () => {
      onTap();
      const driver = await open();
      await driver.tick();
      ended(merged, 'merged');
      ended(other, 'merged');
      await driver.tick();
      const [made] = opened();
      github.issue(brewery, made?.number ?? 0).state = 'gone';
      orderAgain('web-7-2');
      await driver.tick();
      assert.deepStrictEqual(store.findEffect({ batchId: 'web-7-2', effect: 'order.reopen' }), {
        result: 'gone',
      });
      assert.deepStrictEqual(notices, []);
    });

    it('closes it when every pull request merged, as the release of the claim', async () => {
      onTap();
      const driver = await open();
      await driver.tick();
      ended(merged, 'merged');
      ended(other, 'merged');
      await driver.tick();
      assert.equal(opened()[0]?.state, 'closed');
      assert.deepStrictEqual(ledger('release.order'), { result: null });
      assert.equal(github.refs.has(`${repo}#7`), false);
    });

    it('leaves it open when the batch is cancelled, as the target issue stays open', async () => {
      order();
      const driver = await open();
      await driver.tick();
      issue({ kind: 'cancel', batchId: 'web-7', by: 'alice', via: 'terminal' });
      await driver.tick();
      assert.equal(opened()[0]?.state, 'open');
      assert.equal(github.refs.has(`${repo}#7`), false);
    });

    it('orders the same Brewery issue again when the issue is ordered again (ADR 0105)', async () => {
      order();
      const driver = await open();
      await driver.tick();
      issue({ kind: 'cancel', batchId: 'web-7', by: 'alice', via: 'terminal' });
      await driver.tick();
      orderAgain('web-7-2');
      await driver.tick();
      assert.equal(opened().length, 1);
      assert.equal(store.findEffect({ batchId: 'web-7-2', effect: 'order.issue' }), undefined);
    });

    it('reopens it when the issue is ordered again after a merge closed it', async () => {
      onTap();
      const driver = await open();
      await driver.tick();
      ended(merged, 'merged');
      ended(other, 'merged');
      await driver.tick();
      orderAgain('web-7-2');
      await driver.tick();
      assert.equal(opened().length, 1);
      assert.equal(opened()[0]?.state, 'open');
      assert.deepStrictEqual(store.findEffect({ batchId: 'web-7-2', effect: 'order.reopen' }), {
        result: null,
      });
    });
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

  it('refuses a comment id the code host finds that is no positive integer, recording nothing', async () => {
    order();
    const driver = await open({
      marks: { ...github.marks(alice.login), findComment: async () => 0 },
    });
    await driver.tick();
    assert.equal(ledger('claim.comment'), undefined);
    assert.ok(
      notices.some(
        (notice) => notice.kind === 'effect_failed' && notice.key.effect === 'claim.comment',
      ),
    );
  });

  it('hands every call to the code host the signal of its effect', async () => {
    const signals: { call: string; signal: AbortSignal | undefined }[] = [];
    const base = github.marks(alice.login);
    const marks: IssueMarks = {
      assignees: (r, n, signal) => (
        signals.push({ call: 'assignees', signal }), base.assignees(r, n)
      ),
      assign: (r, n, l, signal) => (signals.push({ call: 'assign', signal }), base.assign(r, n, l)),
      labels: (r, n, signal) => (signals.push({ call: 'labels', signal }), base.labels(r, n)),
      addLabel: (r, n, l, signal) => (
        signals.push({ call: 'addLabel', signal }), base.addLabel(r, n, l)
      ),
      removeLabel: (r, n, l, signal) => (
        signals.push({ call: 'removeLabel', signal }), base.removeLabel(r, n, l)
      ),
      findComment: (r, n, m, signal) => (
        signals.push({ call: 'findComment', signal }), base.findComment(r, n, m)
      ),
      comment: (r, n, b, signal) => (
        signals.push({ call: 'comment', signal }), base.comment(r, n, b)
      ),
      title: (r, n, signal) => (signals.push({ call: 'title', signal }), base.title(r, n)),
      issueState: (r, n, signal) => (
        signals.push({ call: 'issueState', signal }), base.issueState(r, n)
      ),
      setIssueState: (r, n, s, signal) => (
        signals.push({ call: 'setIssueState', signal }), base.setIssueState(r, n, s)
      ),
      findIssue: (r, m, signal) => (
        signals.push({ call: 'findIssue', signal }), base.findIssue(r, m)
      ),
      openIssue: (r, t, b, signal) => (
        signals.push({ call: 'openIssue', signal }), base.openIssue(r, t, b)
      ),
    };
    const host = github.host;
    const claims = {
      create: host.create,
      read: (r: string, n: number, signal?: AbortSignal) => (
        signals.push({ call: 'read', signal }), host.read(r, n)
      ),
      delete: (r: string, n: number, s: string, signal?: AbortSignal) => (
        signals.push({ call: 'delete', signal }), host.delete(r, n, s)
      ),
    };
    order();
    const driver = await openDriver({
      store,
      runner: { start: () => assert.fail('no attempt starts'), progress: () => undefined },
      recipes,
      clock: () => now,
      lock: () => fakeLock('cellar'),
      takes: () => true,
      stateBranch: { flush: async () => ({ kind: 'unchanged' }) },
      limits: () => defaultLimits,
      effects: claimEffects({ claimant: alice, marks, claims }),
    });
    drivers.push(driver);
    await driver.tick();
    issue({ kind: 'cancel', batchId: 'web-7', by: 'alice', via: 'terminal' });
    await driver.tick();
    const calls = signals.map(({ call }) => call);
    for (const call of [
      'assignees',
      'assign',
      'labels',
      'addLabel',
      'findComment',
      'comment',
      'findIssue',
      'title',
      'openIssue',
      'removeLabel',
      'read',
      'delete',
    ]) {
      assert.ok(calls.includes(call), call);
    }
    assert.ok(
      signals.every(({ signal }) => signal instanceof AbortSignal),
      JSON.stringify(calls),
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
