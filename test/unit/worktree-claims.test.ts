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
});
