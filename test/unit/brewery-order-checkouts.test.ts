// The pure core of a Brewery order's checkouts (ADR 0301): how each is named, made and cleaned.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type Claims,
  checkoutName,
  type ListedFact,
  planCheckout,
  planCheckoutClean,
} from '../../src/workspace/attempt-worktrees.ts';

describe('checkoutName (ADR 0301)', () => {
  it('names a checkout by <owner>.<name> when its alias is a Windows device name', () => {
    assert.equal(checkoutName('acme/app', 'aux'), 'acme.app');
    assert.equal(checkoutName('acme/app', 'app'), 'app');
  });
});

describe('planCheckout (ADR 0301): regression tests', () => {
  const label = '12-1/plan/1/app';
  const at = 'a'.repeat(40);
  const listed = (state: ListedFact['state'], branch?: string) => ({
    state,
    branch,
    record: '/clone/.git/worktrees/app',
  });

  it('reuses a detached checkout that is there only for a resume', () => {
    const facts = { listed: listed('dirty'), exists: true };
    assert.deepEqual(planCheckout(label, facts, { kind: 'resume', commit: at }), {
      kind: 'reuse',
    });
    assert.deepEqual(planCheckout(label, facts, { kind: 'new', base: at }), {
      kind: 'refuse',
      reason: 'the checkout 12-1/plan/1/app is there already (dirty)',
    });
  });

  it('refuses a checkout on a branch, or one that cannot be read, also for a resume', () => {
    const target = { kind: 'resume', commit: at } as const;
    for (const facts of [listed('clean', 'foedrum/12-1/plan/1'), listed('foreign')]) {
      const plan = planCheckout(label, { listed: facts, exists: true }, target);
      assert.equal(plan.kind, 'refuse', JSON.stringify(facts));
    }
  });

  it('refuses a folder git does not know', () => {
    assert.deepEqual(
      planCheckout(label, { listed: undefined, exists: true }, { kind: 'new', base: at }),
      {
        kind: 'refuse',
        reason: '12-1/plan/1/app is a folder git does not know',
      },
    );
  });

  it('adds it at the base, or at the recorded commit, pruning a record whose folder is gone', () => {
    const commit = 'b'.repeat(40);
    assert.deepEqual(
      planCheckout(label, { listed: undefined, exists: false }, { kind: 'new', base: at }),
      {
        kind: 'add',
        prune: undefined,
        at,
      },
    );
    const gone = { listed: listed('gone'), exists: false };
    assert.deepEqual(planCheckout(label, gone, { kind: 'resume', commit }), {
      kind: 'add',
      prune: '/clone/.git/worktrees/app',
      at: commit,
    });
  });
});

describe('planCheckoutClean (ADR 0301): regression tests', () => {
  const checkout = (inside: string, more: Partial<Omit<ListedFact, 'inside'>> = {}) => ({
    path: `/work/brewery-orders/${inside}`,
    inside,
    branch: undefined,
    lockReason: undefined,
    state: 'clean' as const,
    record: `/clone/.git/worktrees/${inside.replaceAll('/', '-')}`,
    ...more,
  });
  const claims = (more: Partial<Claims> = {}): Claims => ({
    batches: new Map([
      ['12-1', 'ended'],
      ['13-1', 'ended'],
      ['14-1', 'live'],
    ]),
    leased: [],
    ...more,
  });
  const labels = (plan: ReturnType<typeof planCheckoutClean>) =>
    plan.actions.map(({ label }) => label);

  it("removes an ended batch's clean checkout, and only the batch in scope", () => {
    const plan = planCheckoutClean(
      [checkout('13-1/plan/1/app'), checkout('12-1/plan/1/app')],
      claims(),
      { batchId: '12-1' },
    );
    assert.deepEqual([labels(plan), plan.kept], [['12-1/plan/1/app'], []]);
  });

  it("leaves a live batch's checkout without a word", () => {
    const plan = planCheckoutClean([checkout('14-1/plan/1/app')], claims());
    assert.deepEqual([plan.actions, plan.kept], [[], []]);
  });

  it('keeps a leased, a locked and a dirty checkout, saying why', () => {
    const plan = planCheckoutClean(
      [
        checkout('12-1/plan/1/app'),
        checkout('12-1/plan/2/app', { lockReason: 'on a removable drive' }),
        checkout('12-1/plan/3/app', { state: 'dirty' }),
      ],
      claims({ leased: [{ batchId: '12-1', stepId: 'plan', attempt: 1 }] }),
    );
    assert.deepEqual(plan.actions, []);
    assert.deepEqual(plan.kept, [
      'kept checkout 12-1/plan/1/app: its attempt holds a live lease',
      'kept checkout 12-1/plan/2/app: locked: on a removable drive',
      'kept checkout 12-1/plan/3/app: it has uncommitted or untracked changes',
    ]);
  });

  it('keeps a worktree in the orders folder that is no checkout folder', () => {
    const plan = planCheckoutClean([checkout('12-1/plan')], claims());
    assert.deepEqual(plan.kept, ['kept worktree brewery-orders/12-1/plan: not a checkout folder']);
  });
});
