// Two drivers on one store, each told to take every batch, killed at random points and restarted
// (#107, ADR 0044): each attempt is started by one of them at most once, only under its batch's
// lease, and no effect is applied twice. The run count is FOEDRUM_RUNS, as for restarts.test.ts.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { attemptKey } from '../../src/engine/attempt-key.ts';
import {
  type ChaosEngine,
  type ChaosRun,
  fakeCodeHost,
  holdsAcrossKills,
  killPlan,
  openChaosEngine,
  runChaos,
} from '../helpers/chaos.ts';
import { nothingLeftWaiting, restsWithEffectsOnce } from '../helpers/chaos-checks.ts';
import { generateScenario, recording, type Scenario } from '../helpers/event-sequences.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';

let dir: TempDir;
before(() => {
  dir = makeTempDir('chaos-drivers');
});
after(() => dir.remove());

const drivers = ['cellar', 'session'] as const;

/** Each attempt started at most once, by one driver: a retry is an attempt of its own. */
const startsOnce = ({ engine }: ChaosRun): void => {
  const by = new Map<string, string>();
  for (const { kind, key, driver } of engine.acts) {
    if (kind !== 'start') continue;
    assert.equal(by.get(key), undefined, `attempt ${key} started by ${by.get(key)} and ${driver}`);
    by.set(key, driver);
  }
};

/** A driver starts an attempt or applies an effect only while it holds the batch's live lease. */
const underItsLease = ({ engine }: ChaosRun): void => {
  for (const { driver, kind, key, held } of engine.acts) {
    assert.ok(held, `${driver} made ${kind} ${key} without the lease of its batch`);
  }
};

/** No two `applyEffect` calls for one key overlap (ADR 0033). */
const noOverlap = ({ host }: ChaosRun): void => {
  assert.deepStrictEqual(host.overlaps, [], 'calls for one effect key overlapped');
};

/** What two drivers competing for batches must keep: after every move, and at the end. */
const competing = (run: ChaosRun): void => {
  startsOnce(run);
  underItsLease(run);
  noOverlap(run);
};

/** Who started each attempt, by attempt key. */
const starters = (engine: ChaosEngine): Map<string, string> =>
  new Map(
    engine.acts.flatMap(({ kind, key, driver }) => (kind === 'start' ? [[key, driver]] : [])),
  );

/**
 * An attempt lost with the lease of a driver that went down after a kill (ADR 0027 names the
 * owner of the expired lease), and its retry started by the other driver.
 */
const retriedByTheOther = (engine: ChaosEngine): boolean => {
  const by = starters(engine);
  const down = new Set(engine.downs.map(({ driver }) => driver));
  return engine.events().some((event) => {
    if (event.type !== 'step.finished' || event.outcome.kind !== 'failed') return false;
    const lost = /^the attempt was lost: the lease of (\S+) expired/.exec(
      event.outcome.reason,
    )?.[1];
    if (lost === undefined || !down.has(lost)) return false;
    const { batchId, stepId, attempt } = event;
    const retry = by.get(attemptKey.encode({ batchId, stepId, attempt: attempt + 1 }));
    return retry !== undefined && retry !== lost;
  });
};

/** What the runs with two drivers must reach between them, each asked of one finished run. */
const goals: Readonly<Record<string, (engine: ChaosEngine) => boolean>> = {
  // Two drivers competing for one batch.
  'a driver found the other holding a batch it wanted': (engine) => engine.contests.length > 0,
  ...Object.fromEntries(
    drivers.flatMap((driver) => [
      [
        `${driver} started an attempt`,
        (engine: ChaosEngine) => [...starters(engine).values()].includes(driver),
      ],
      [
        `${driver} applied an effect`,
        (engine: ChaosEngine) =>
          engine.acts.some((act) => act.driver === driver && act.kind === 'apply'),
      ],
    ]),
  ),
  // A driver killed while it holds a batch, its brewer running on.
  'a batch taken over from a driver that was down': (engine) => engine.takeovers.length > 0,
  'an attempt lost with a driver that was down, retried by the other': retriedByTheOther,
};

describe('two drivers on one store', () => {
  it('start each attempt once, under its batch lease, and apply no effect twice', () =>
    holdsAcrossKills(
      dir.path,
      {
        afterMove: (run, move, survived) => {
          competing(run);
          restsWithEffectsOnce.afterMove(run, move, survived);
          // A batch whose driver went down is taken over once its lease expired.
          if (move.kind === 'tick' && survived) nothingLeftWaiting(run);
        },
        // The last pass of effects comes after the last move.
        atEnd: (run) => {
          competing(run);
          restsWithEffectsOnce.atEnd(run);
        },
      },
      { drivers },
    ));

  let runs = 0;
  /** How many seeds the coverage test may try before it fails. */
  const maxSeeds = 30;

  it('reach every case of #107: competing drivers, a takeover from a driver that is down', async () => {
    const wanted = Object.keys(goals);
    const seen = new Set<string>();
    // Fixed seeds, the first ones until every goal is reached: what the harness reaches does not
    // depend on FOEDRUM_SEED.
    for (let seed = 1; seed <= maxSeeds && wanted.some((what) => !seen.has(what)); seed++) {
      const path = join(dir.path, `run-${++runs}-seed-${seed}.sqlite`);
      const scenario: Scenario = { moves: [], plays: [] };
      const source = recording(generateScenario(seed), scenario);
      const host = fakeCodeHost();
      const plays = (attempt: Parameters<typeof source.play>[0]) => source.play(attempt);
      const engine: ChaosEngine = await openChaosEngine(path, plays, killPlan(seed), host, {
        drivers,
      });
      try {
        await runChaos({ engine, host, scenario, moves: [] }, source);
        for (const [what, reached] of Object.entries(goals)) if (reached(engine)) seen.add(what);
      } finally {
        engine.close();
      }
    }
    assert.deepStrictEqual(
      wanted.filter((what) => !seen.has(what)),
      [],
    );
  });
});
