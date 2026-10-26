// An interactive step (ADR 0222) under kills: `foedrum brew` on a terminal (a driver that opens
// sessions, which retries a batch waiting for one at its start) and `foedrum serve` (one that opens
// none and parks the step) on one store, with brew killed while the session is open, after claude
// exited but before its end was recorded, and between serve's park and brew's retry, once and twice,
// then brewed again until it no longer waits for a session. In every run the step never runs
// headless, no attempt finishes twice, and the batch ends on tap after exactly one success of the step.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type AttemptRef, attemptKey } from '../../src/engine/attempt-key.ts';
import { defaultLeaseMs, takeOver } from '../../src/engine/batch-leases.ts';
import type { AttemptEnd, BrewerRunner } from '../../src/engine/brewer-runner.ts';
import { createCommandLog } from '../../src/engine/command-log.ts';
import { type Driver, openDriver } from '../../src/engine/driver.ts';
import type { EventStore } from '../../src/engine/event-store.ts';
import type { Batch } from '../../src/engine/fold.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import { defaultLimits } from '../helpers/brewing.ts';
import { fakeLock } from '../helpers/fake-lock.ts';
import { fakeRecipe, fakeRecipes } from '../helpers/fake-recipes.ts';

const t0 = new Date('2026-10-26T12:00:00.000Z');
const recipes = fakeRecipes({
  // Attempts to spare: every kill loses one.
  lauter: fakeRecipe({ steps: ['refine', 'pour'], interactive: ['refine'], maxAttempts: 10 }),
});

/** Where a process ends: killed with the session open, killed after claude exited, or never. */
type Kill = 'open' | 'exited' | 'parked';

/** What one run did: every start, by whether its driver opens sessions. */
interface Started {
  key: string;
  sessions: boolean;
}

const done: AttemptEnd = {
  ending: { kind: 'succeeded', output: { status: 'done', summary: 'Done', assumptions: [] } },
};

/** A runner whose attempts end when the test says, recording each start. */
const handRunner = (sessions: boolean, starts: Started[]) => {
  const running = new Map<string, (end: AttemptEnd) => void>();
  const runner: BrewerRunner = {
    start: ({ ref }) => {
      const key = attemptKey.encode(ref);
      starts.push({ key, sessions });
      const ended = new Promise<AttemptEnd>((resolve) => running.set(key, resolve));
      // A stop does not end a person's session (ADR 0127): only the test ends it.
      return { ended, stop: () => {} };
    },
    progress: (ref) =>
      running.has(attemptKey.encode(ref))
        ? { lastProgressAt: t0, turnsWithoutProgress: 0 }
        : undefined,
  };
  const endAll = (end: AttemptEnd): void => {
    for (const [key, resolve] of running) {
      running.delete(key);
      resolve(end);
    }
  };
  return { runner, running: () => running.size > 0, endAll };
};

const lane = (store: EventStore): Batch['lane'] | undefined =>
  createCommandLog({ store, recipes }).state().batches.get('12-1')?.lane;

/**
 * One process on the store: brew (sessions) or serve (none), killed at `kill` or run until the
 * batch stops. A brew retries a batch waiting for a session at its start, as `runBrew` does.
 */
const process = async (
  store: EventStore,
  starts: Started[],
  sessions: boolean,
  kill?: Kill,
): Promise<void> => {
  const { runner, running, endAll } = handRunner(sessions, starts);
  let driver: Driver | undefined;
  try {
    driver = await openDriver({
      store,
      runner,
      recipes,
      clock: () => t0,
      lock: () => fakeLock(sessions ? 'ann' : 'cellar'),
      takes: () => true,
      sessions,
      stateBranch: { flush: async () => ({ kind: 'unchanged' }) },
      limits: () => defaultLimits,
    });
    const now = lane(store);
    if (sessions && now?.kind === 'stuck' && now.reason.kind === 'waiting_for_session') {
      if (kill === 'parked') return;
      // A batch serve parked is held by serve's lease: brew --take takes it (ADR 0124).
      const held = store.batchLeases(t0).find((lease) => lease.batchId === '12-1');
      if (held !== undefined && held.owner !== 'ann') {
        const handover = { batchId: '12-1', owner: 'ann', by: 'ann', via: 'terminal' } as const;
        const taken = takeOver(createCommandLog({ store, recipes }), {
          ...handover,
          now: t0,
          leaseMs: defaultLeaseMs,
        });
        assert.equal(taken.kind, 'accepted');
      }
      const retry = { kind: 'retry', batchId: '12-1', by: 'ann', via: 'terminal' } as const;
      assert.equal(createCommandLog({ store, recipes }).issue(retry, t0).kind, 'accepted');
    }
    for (let tick = 0; tick < 20; tick++) {
      await driver.tick();
      if (running()) {
        if (kill === 'open') return;
        // claude exits; a kill before the next pass records nothing of it.
        endAll(done);
        if (kill === 'exited') return;
      }
      const after = lane(store);
      if (after?.kind === 'stuck') return;
      // serve leaves a batch another driver's live lease holds, until it lapses.
      if (!sessions && !driver.held().includes('12-1')) return;
      if (after?.kind === 'on_tap' && !driver.held().includes('12-1')) return;
    }
    assert.fail(`the batch did not stop: ${JSON.stringify(lane(store))}`);
  } finally {
    driver?.close();
  }
};

/** Every sequence of one or two kills. */
const KILLS: readonly Kill[] = ['open', 'exited', 'parked'];
const scenarios: Kill[][] = [
  ...KILLS.map((kill) => [kill]),
  ...KILLS.flatMap((first) => KILLS.map((second) => [first, second])),
];

describe('an interactive step under kills (ADR 0222)', () => {
  for (const kills of scenarios) {
    it(`never runs headless and ends on tap after one success: brew killed ${kills.join(', then ')}`, async () => {
      const store = openSqliteEventStore(':memory:');
      const starts: Started[] = [];
      try {
        const intake = createCommandLog({ store, recipes });
        intake.issue({ kind: 'order', batchId: '12-1', order: { issue: 12 } }, t0);
        const route = {
          kind: 'route',
          batchId: '12-1',
          recipe: 'lauter',
          reason: 'label',
          source: 'label',
        } as const;
        assert.equal(intake.issue(route, t0).kind, 'accepted');
        for (const kill of kills) {
          // serve met the step first, and parked it, before a brew killed at `parked`.
          if (kill === 'parked') await process(store, starts, false);
          await process(store, starts, true, kill);
        }
        // The person runs brew again until the batch no longer waits for a session: a brew after a
        // kill may first lose the killed attempt and park the batch, and the next one opens it.
        for (let brews = 0; brews < 3; brews++) {
          await process(store, starts, true);
          const now = lane(store);
          if (now?.kind !== 'stuck' || now.reason.kind !== 'waiting_for_session') break;
        }

        const refine = starts.filter(({ key }) => attemptKey.decode(key)?.stepId === 'refine');
        assert.ok(refine.length > 0, 'the step never opened');
        assert.deepStrictEqual(
          refine.filter(({ sessions }) => !sessions),
          [],
          'the interactive step ran in a driver that opens no session',
        );
        const finished = store
          .eventsAfter(0)
          .flatMap(({ event }) =>
            event.type === 'step.finished' ? [attemptKey.encode(event as AttemptRef)] : [],
          );
        assert.equal(new Set(finished).size, finished.length, 'an attempt finished twice');
        const state = createCommandLog({ store, recipes }).state();
        const batch = state.batches.get('12-1');
        const successes = [...(batch?.steps.get('refine')?.attempts.values() ?? [])].filter(
          (attempt) => attempt.phase === 'finished' && attempt.outcome.kind === 'succeeded',
        );
        assert.equal(batch?.lane.kind, 'on_tap', JSON.stringify(batch?.lane));
        assert.equal(successes.length, 1);
      } finally {
        store.close();
      }
    });
  }
});
