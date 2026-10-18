import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { attemptKey } from '../../src/engine/attempt-key.ts';
import { type Batch, emptyState, type Lane } from '../../src/engine/fold.ts';
import { worktreeClaims } from '../../src/engine/worktree-claims.ts';

const batch = (id: string, lane: Lane): Batch => ({
  id,
  issue: 1,
  lane,
  steps: new Map(),
  rewinds: [],
});

const lanes: Record<string, Lane> = {
  ordered: { kind: 'ordered', routeBy: '2026-10-15T00:00:00.000Z' },
  brewing: { kind: 'brewing' },
  conditioning: {
    kind: 'conditioning',
    on: { kind: 'sibling', batchId: 'brewing' },
    remindAt: '2026-10-15T00:00:00.000Z',
  },
  stuck: {
    kind: 'stuck',
    reason: { kind: 'waiting_for_session', stepId: 'implement' },
    options: ['retry'],
    remindAt: '2026-10-15T00:00:00.000Z',
  },
  'on-tap': { kind: 'on_tap', pullRequests: ['https://github.com/acme/app/pull/1'] },
  cancelled: { kind: 'cancelled', by: 'me', via: 'terminal' },
};

describe('worktreeClaims', () => {
  it('keeps every batch live until it is on tap or cancelled', () => {
    const state = {
      ...emptyState,
      batches: new Map(Object.entries(lanes).map(([id, lane]) => [id, batch(id, lane)])),
    };

    const claims = worktreeClaims(state, []);

    assert.deepEqual(
      claims.batches,
      new Map([
        ['ordered', 'live'],
        ['brewing', 'live'],
        ['conditioning', 'live'],
        // A Stuck batch keeps its worktrees: a human may take over or resume.
        ['stuck', 'live'],
        ['on-tap', 'ended'],
        ['cancelled', 'ended'],
      ]),
    );
  });

  it('names the attempts of the live leases, and skips a lease that names no attempt', () => {
    const expiresAt = new Date('2026-10-15T00:00:00.000Z');
    const attempt = { batchId: '12-1', stepId: 'implement', attempt: 2 };
    const leases = [
      { attemptKey: attemptKey.encode(attempt), owner: 'driver', expiresAt },
      { attemptKey: 'batch 12-1', owner: 'driver', expiresAt },
    ];

    assert.deepEqual(worktreeClaims(emptyState, leases).leased, [attempt]);
  });

  it('names the out doc of every step of an ended batch whose brewer is known (ADR 0081)', () => {
    const steps = new Map(
      ['brew', 'check'].map((id) => [id, { id, attempts: new Map(), inputs: [] }]),
    );
    const state = {
      ...emptyState,
      batches: new Map(
        (['brewing', 'stuck', 'on-tap', 'cancelled'] as const).map((id) => [
          id,
          { ...batch(id, lanes[id] as Lane), steps },
        ]),
      ),
    };
    const asked: string[] = [];
    // A check step has no brewer, so no out doc.
    const outDoc = ({ batchId, stepId }: { batchId: string; stepId: string }) => {
      asked.push(`${batchId}/${stepId}`);
      return stepId === 'brew' ? 'brew.md' : undefined;
    };

    const claims = worktreeClaims(state, [], outDoc);

    assert.deepEqual(
      claims.outDocs,
      new Map([
        ['on-tap/brew', 'brew.md'],
        ['cancelled/brew', 'brew.md'],
      ]),
    );
    // A live batch keeps its worktrees anyway: its brewers are not looked up.
    assert.deepEqual(asked, ['on-tap/brew', 'on-tap/check', 'cancelled/brew', 'cancelled/check']);
  });
});
