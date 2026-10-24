// What the chaos harness (#15) reaches: kills at every kind of point, and what a restart must
// recover from. Without this, a harness whose kills never land in the right places would pass.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { Event } from '../../src/schemas/events.ts';
import {
  type ChaosRun,
  fakeCodeHost,
  killPlan,
  killPoints,
  openChaosEngine,
  runChaos,
} from '../helpers/chaos.ts';
import {
  generateScenario,
  recording,
  replaying,
  type Scenario,
  scenarioRecipes,
} from '../helpers/event-sequences.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';

let dir: TempDir;
before(() => {
  dir = makeTempDir('chaos-kills');
});
after(() => dir.remove());

let runs = 0;

/** How many seeds a coverage test may try before it fails. */
const maxSeeds = 30;

/** Runs `seed`'s scenario with its kill plan, recorded into `scenario`, or replays `scenario`. */
const chaos = async <T>(
  seed: number,
  scenario: Scenario,
  replay: boolean,
  what: (run: ChaosRun) => T,
): Promise<T> => {
  // A database of its own: a run that found another's events would not start from scratch.
  const path = join(dir.path, `run-${++runs}-seed-${seed}.sqlite`);
  const source = replay ? replaying(scenario) : recording(generateScenario(seed), scenario);
  const host = fakeCodeHost();
  const engine = await openChaosEngine(
    path,
    (attempt) => source.play(attempt),
    killPlan(seed),
    host,
  );
  try {
    const run: ChaosRun = { engine, host, scenario, moves: [] };
    await runChaos(run, source);
    return what(run);
  } finally {
    engine.close();
  }
};

/** The children of each parallel group of the scenario recipes, by step id (ADR 0168). */
const siblings = new Map(
  Object.values(scenarioRecipes).flatMap(({ groups = {} }) =>
    Object.values(groups).flatMap((children) =>
      children.map((child) => [child, children.filter((other) => other !== child)] as const),
    ),
  ),
);

/**
 * Whether the lost attempt that `events[at]` finishes is a child of a parallel group, a sibling of
 * which had succeeded before the loss, and whose retry was scheduled with no new attempt of that
 * sibling: the kill resumed only the children that had not ended (ADR 0168).
 */
const retriedAlone = (events: readonly Event[], at: number): boolean => {
  const lost = events[at];
  if (lost?.type !== 'step.finished') return false;
  const { batchId, stepId, attempt } = lost;
  const ofBatch = (event: Event | undefined, step: string) =>
    event !== undefined && 'batchId' in event && event.batchId === batchId && 'stepId' in event
      ? event.stepId === step
      : false;
  const retry = events.findIndex(
    (event, index) =>
      index > at &&
      event.type === 'step.scheduled' &&
      ofBatch(event, stepId) &&
      event.attempt === attempt + 1,
  );
  if (retry < 0) return false;
  return (siblings.get(stepId) ?? []).some((sibling) => {
    // The sibling's latest event before the loss is a success, and it gets no attempt until the retry.
    const before = events
      .slice(0, at)
      .findLastIndex(
        (event) =>
          (event.type === 'step.scheduled' || event.type === 'step.finished') &&
          ofBatch(event, sibling),
      );
    const latest = events[before];
    return (
      latest?.type === 'step.finished' &&
      latest.outcome.kind === 'succeeded' &&
      !events
        .slice(at, retry + 1)
        .some((event) => event.type === 'step.scheduled' && ofBatch(event, sibling))
    );
  });
};

describe('chaos runs', () => {
  it('kill the engine at every kind of point, and restart into what it must recover from', async () => {
    const wanted = [
      ...killPoints.map((point) => `killed ${point}`),
      'an effect found on the code host, not applied again',
      'killed again soon after a restart',
      'an attempt of the killed run lost and retried',
      'a kill mid-group retried only the children that had not ended',
    ];
    const seen = new Set<string>();
    // Fixed seeds, so what the harness reaches does not depend on FOEDRUM_SEED: the first ones
    // until every goal is reached, within a bound, so a change to the generator or the driver
    // needs no seeds picked by hand.
    for (let seed = 1; seed <= maxSeeds && wanted.some((what) => !seen.has(what)); seed++) {
      await chaos(seed, { moves: [], plays: [] }, false, ({ engine }) => {
        for (const { point } of engine.kills) seen.add(`killed ${point}`);
        if (engine.found > 0) seen.add('an effect found on the code host, not applied again');
        const killedAt = new Set(engine.kills.map(({ move }) => move));
        if (killedAt.size < engine.kills.length) seen.add('killed again soon after a restart');
        // A restart expires the killed run's leases at once, so the reason names its time.
        const restarted = engine.restarts.map((at) => `expired at ${at.toISOString()}`);
        const events = engine.events();
        for (const [at, event] of events.entries()) {
          if (event.type !== 'step.finished' || event.outcome.kind !== 'failed') continue;
          const { reason } = event.outcome;
          const { batchId, stepId, attempt } = event;
          // The next attempt of the step is scheduled after the loss: a retry, not Stuck.
          const retried = events
            .slice(at + 1)
            .some(
              (later) =>
                later.type === 'step.scheduled' &&
                later.batchId === batchId &&
                later.stepId === stepId &&
                later.attempt === attempt + 1,
            );
          if (
            retried &&
            reason.startsWith('the attempt was lost') &&
            restarted.some((expiry) => reason.endsWith(expiry))
          ) {
            seen.add('an attempt of the killed run lost and retried');
            if (retriedAlone(events, at)) {
              seen.add('a kill mid-group retried only the children that had not ended');
            }
          }
        }
      });
    }
    assert.deepStrictEqual(
      wanted.filter((what) => !seen.has(what)),
      [],
    );
  });

  it('append the same events and kill at the same points when replayed', async () => {
    let killed = 0;
    for (let seed = 2; seed <= 3; seed++) {
      const scenario: Scenario = { moves: [], plays: [] };
      const played = (run: ChaosRun) => ({ events: run.engine.events(), kills: run.engine.kills });
      const first = await chaos(seed, scenario, false, played);
      if (first.kills.length > 0) killed++;
      assert.deepStrictEqual(await chaos(seed, scenario, true, played), first, `seed ${seed}`);
    }
    assert.equal(killed, 2, 'both runs kill the engine');
  });
});
