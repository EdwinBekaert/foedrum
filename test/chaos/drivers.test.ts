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
import { nothingLeftWaiting, restsWithEffectsOnce, theLogHolds } from '../helpers/chaos-checks.ts';
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

/** What two drivers and a terminal writing to one store must keep: after every move, and at the end. */
/** A driver that starts again under its owner holds the batches its owner's live leases name. */
const drivesOnItsBatches = ({ engine }: ChaosRun): void => {
  for (const { driver, leased, held } of engine.resumes) {
    assert.deepStrictEqual(held, [...leased].sort(), `${driver} started again holding its batches`);
  }
};

const competing = (run: ChaosRun): void => {
  startsOnce(run);
  underItsLease(run);
  noOverlap(run);
  theLogHolds(run);
  drivesOnItsBatches(run);
};

/** Who started each attempt, by attempt key. */
const starters = (engine: ChaosEngine): Map<string, string> =>
  new Map(
    engine.acts.flatMap(({ kind, key, driver }) => (kind === 'start' ? [[key, driver]] : [])),
  );

/**
 * The attempts lost when their lease expired, with the owner of that lease (the supervisor names
 * it, ADR 0027) and the driver that started their retry, if one did.
 */
const lostAndRetried = (engine: ChaosEngine): { lost: string; retry: string | undefined }[] => {
  const by = starters(engine);
  return engine.events().flatMap((event) => {
    if (event.type !== 'step.finished' || event.outcome.kind !== 'failed') return [];
    const lost = /^the attempt was lost: the lease of (\S+) expired/.exec(
      event.outcome.reason,
    )?.[1];
    if (lost === undefined) return [];
    const { batchId, stepId, attempt } = event;
    return [{ lost, retry: by.get(attemptKey.encode({ batchId, stepId, attempt: attempt + 1 })) }];
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
  'an attempt lost with a driver that was down, retried by the other': (engine) => {
    const down = new Set(engine.downs.map(({ driver }) => driver));
    return lostAndRetried(engine).some(
      ({ lost, retry }) => down.has(lost) && retry !== undefined && retry !== lost,
    );
  },
  // A driver that loses its batch while an attempt runs: it stops the run, and starts or applies
  // nothing more there (underItsLease).
  'a driver lost a batch while an attempt of it ran': (engine) =>
    engine.losses.some(({ running }) => running.length > 0),
  'a driver stopped the run of an attempt in a batch it lost': (engine) =>
    engine.stops.some(({ driver, key }) =>
      engine.losses.some((loss) => loss.driver === driver && loss.running.includes(key)),
    ),
  // A terminal command between a driver's read and its append: the command log decides on the
  // latest events, so the driver's command is refused or decided on them, and the log never
  // breaks (every read folds it).
  "a terminal command accepted between a driver's read and its append": (engine) =>
    engine.interjections.some(({ accepted }) => accepted),
  "a driver's command refused after a terminal command came before it": (engine) =>
    engine.moot.length > 0,
  // A driver restarted under its owner: it drives on the batches it held, and its earlier
  // attempts are lost and retried (ADR 0033).
  'a driver started again drove on a batch it held': (engine) =>
    engine.resumes.some(({ driver, held, actsBefore }) =>
      engine.acts
        .slice(actsBefore)
        .some((act) => act.driver === driver && held.includes(act.batchId)),
    ),
  'an attempt of a killed driver lost and retried by it after its restart': (engine) =>
    lostAndRetried(engine).some(
      ({ lost, retry }) => retry === lost && engine.resumes.some(({ driver }) => driver === lost),
    ),
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

  it('reach every case of #107', async () => {
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
