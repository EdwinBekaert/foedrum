// Invariant I2 (architecture §4.4) over generated engine scenarios (test/helpers/property.ts), and
// over generated logs of resumed attempts, which share a worktree one after the other (ADR 0029).

import assert from 'node:assert/strict';
import { it } from 'node:test';
import { attemptKey } from '../../src/engine/attempt-key.ts';
import type { Lease } from '../../src/engine/event-store.ts';
import { fold } from '../../src/engine/fold.ts';
import { worktreeClaims } from '../../src/engine/worktree-claims.ts';
import type { Event } from '../../src/schemas/events.ts';
import { seededRandom } from '../helpers/event-sequences.ts';
import { forEachSeed, holdsInScenarios } from '../helpers/property.ts';
import { sessionRef } from '../helpers/sessions.ts';

it('I2: at most one live lease per attempt and per worktree', () =>
  holdsInScenarios({
    afterMove: (engine) => {
      // The store keys leases by attempt, so one per attempt holds by construction, and every
      // attempt works in its own worktree (ADR 0012). A step runs one attempt at a time, so a
      // second live lease of a step is an attempt that no longer runs.
      const byStep = new Map<string, string[]>();
      for (const lease of engine.store.currentLeases(engine.now())) {
        const ref = attemptKey.decode(lease.attemptKey);
        assert.ok(ref, `lease ${lease.attemptKey} names an attempt`);
        const step = `${ref.batchId} ${ref.stepId}`;
        byStep.set(step, [...(byStep.get(step) ?? []), lease.attemptKey]);
      }
      for (const [step, keys] of byStep) {
        assert.equal(keys.length, 1, `step ${step} has live leases ${keys.join(', ')}`);
      }
    },
  }));

// Resumed attempts (ADR 0029): an attempt that resumes a session runs in the worktree of the
// attempt that started it, so its lease claims that worktree. Logs of attempts that resume earlier
// sessions of their step, in chains, keeping the session's id or taking a new one; the latest
// attempt of a step, when it runs, holds the step's one live lease.
it('I2 with resumed attempts: each live lease claims the worktree it runs in and no other, and no other lease claims it', () =>
  forEachSeed(200, (seed) => {
    const random = seededRandom(seed);
    const at = '2026-10-15T13:00:00.000Z';
    const events: Event[] = [];
    const leases: Lease[] = [];
    // The worktree each live lease's attempt runs in, by its attempt key.
    const runsIn = new Map<string, string>();
    for (const batchId of ['4-1', '5-1'].slice(0, 1 + random.int(2))) {
      events.push({ type: 'batch.ordered', batchId, order: { issue: 4 }, routeBy: at });
      for (const stepId of ['tests', 'implement'].slice(0, 1 + random.int(2))) {
        const sessions: { id: string; worktree: string }[] = [];
        const attempts = 1 + random.int(5);
        for (let attempt = 1; attempt <= attempts; attempt++) {
          const own = `work/${batchId}/${stepId}/${attempt}`;
          const resumed =
            sessions.length > 0 && random.chance(0.6) ? random.pick(sessions) : undefined;
          const id =
            resumed !== undefined && random.chance(0.3)
              ? resumed.id
              : `s${batchId}${stepId}${attempt}`;
          const worktree = resumed?.worktree ?? own;
          sessions.push({ id, worktree });
          const ref = { batchId, stepId, attempt };
          events.push(
            { type: 'step.scheduled', ...ref, deadlineAt: at },
            {
              type: 'step.started',
              ...ref,
              session: sessionRef({
                id,
                ...(resumed === undefined ? {} : { resumes: resumed.id }),
                worktree,
              }),
              ...(resumed === undefined
                ? {
                    worktree: {
                      repo: 'acme/app',
                      path: own,
                      branch: `foedrum/${batchId}/${stepId}/${attempt}`,
                      commit: 'a'.repeat(40),
                    },
                  }
                : {}),
            },
          );
          if (attempt === attempts && random.chance(0.7)) {
            const key = attemptKey.encode(ref);
            leases.push({ attemptKey: key, owner: 'driver', expiresAt: new Date(at) });
            runsIn.set(key, worktree);
          } else {
            const outcome = { kind: 'failed', retryable: true, reason: 'crash' } as const;
            events.push({ type: 'step.finished', ...ref, outcome });
          }
        }
      }
    }
    const state = fold(events);
    // The worktrees a claimed attempt was given, by the attempt's key.
    const given = new Map<string, string>();
    for (const batch of state.batches.values()) {
      for (const step of batch.steps.values()) {
        for (const attempt of step.attempts.values()) {
          if (attempt.phase === 'scheduled' || attempt.worktree === undefined) continue;
          const key = attemptKey.encode({
            batchId: batch.id,
            stepId: step.id,
            attempt: attempt.attempt,
          });
          given.set(key, attempt.worktree.path);
        }
      }
    }
    const claimedBy = new Map<string, string>();
    for (const lease of leases) {
      const claimed = worktreeClaims(state, [lease]).leased.flatMap((ref) => {
        const path = given.get(attemptKey.encode(ref));
        return path === undefined ? [] : [path];
      });
      const worktree = runsIn.get(lease.attemptKey);
      // Every attempt a lease claims ran in its worktree: its session's chain never leaves it.
      assert.deepEqual(
        claimed,
        [worktree],
        `lease ${lease.attemptKey} claims ${claimed.join(', ')}, not ${worktree} alone`,
      );
      for (const path of claimed) {
        const other = claimedBy.get(path);
        assert.equal(other, undefined, `${path} is claimed by ${other} and ${lease.attemptKey}`);
        claimedBy.set(path, lease.attemptKey);
      }
    }
  }));
