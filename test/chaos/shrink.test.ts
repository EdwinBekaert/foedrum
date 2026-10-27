// Shrinking a failing chaos run (#144): a run that fails ends at a smallest schedule that still
// fails the same way, every fault of it at the site it had, and its report names the seed. The
// failures here come from checks that fail on purpose, at faults of each kind a schedule holds.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { ChaosChecks, ChaosOptions } from '../helpers/chaos.ts';
import {
  type ChaosSchedule,
  checkSeed,
  type FoundFailure,
  failureKind,
  type Shrunk,
  shrinkChaos,
  trialChaos,
} from '../helpers/chaos-shrink.ts';
import { generateScenario } from '../helpers/event-sequences.ts';
import { describeEvent, runsIn } from '../helpers/property.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';

let dir: TempDir;
before(() => {
  dir = makeTempDir('chaos-shrink');
});
after(() => dir.remove());

/** How many seeds a test may try for a run that fails its check. */
const maxSeeds = 30;

/** The seeds the replay plays, and the count from which this file runs in full. */
const dozen = 12;

/**
 * The runs this file plays: FOEDRUM_RUNS where it is set, as on CI's Linux leg, or a few in
 * npm run check, where the chaos layer has a time ceiling (ADR 0243). From a dozen on it runs
 * in full: the replay plays its dozen seeds, and a failure is found and shrunk in the forty moves
 * every chaos run plays. Below, the replay plays the last of the dozen, and a failure is found in
 * twelve moves, which hold fewer faults to shrink and still fail in both ways.
 */
const runs = runsIn(process.env, 3);

/** The moves of a run that a failure is found and shrunk in, below a dozen runs. */
const fewerMoves = 12;

const scenarios: ChaosOptions =
  runs >= dozen ? {} : { moves: (seed) => generateScenario(seed, fewerMoves) };

// The first failure found for each check, so the tests that share a check search once.
const found = new Map<ChaosChecks, Promise<FoundFailure>>();

/** The first of the seeds from 1 whose run fails `checks`. */
const firstFailure = (checks: ChaosChecks, options: ChaosOptions): Promise<FoundFailure> => {
  const search = async (): Promise<FoundFailure> => {
    for (let seed = 1; seed <= maxSeeds; seed++) {
      const failure = await trialChaos(dir.path, { seed }, checks, options);
      if (failure !== undefined) return { seed, failure };
    }
    throw new Error(`No seed up to ${maxSeeds} fails the check`);
  };
  const first = found.get(checks) ?? search();
  found.set(checks, first);
  return first;
};

/** Whether `schedule` fails as `kind` does. */
const failsAs = async (
  kind: string,
  schedule: ChaosSchedule,
  checks: ChaosChecks,
  options: ChaosOptions,
): Promise<boolean> => {
  const failure = await trialChaos(dir.path, { schedule }, checks, options);
  return failure !== undefined && failureKind(failure.error) === kind;
};

/** The shrunk schedule fails as the first run did, and no single move or fault can go. */
const isSmallest = async (
  found: FoundFailure,
  { failure, exhausted }: Shrunk,
  checks: ChaosChecks,
  options: ChaosOptions,
): Promise<void> => {
  assert.equal(exhausted, false, 'shrinking finished within its runs');
  const kind = failureKind(found.failure.error);
  const { schedule } = failure;
  assert.ok(await failsAs(kind, schedule, checks, options), 'the shrunk schedule fails again');
  for (const [at, { site }] of schedule.moves.entries()) {
    const moves = schedule.moves.filter((_, i) => i !== at);
    assert.equal(
      await failsAs(kind, { ...schedule, moves }, checks, options),
      false,
      `the run fails without move ${site}`,
    );
  }
  for (const [at, fault] of schedule.faults.entries()) {
    const faults = schedule.faults.filter((_, i) => i !== at);
    assert.equal(
      await failsAs(kind, { ...schedule, faults }, checks, options),
      false,
      `the run fails without the fault ${JSON.stringify(fault)}`,
    );
  }
  for (const [at, { attempt, play }] of schedule.plays.entries()) {
    if (play.kind === 'succeed') continue;
    const plays = schedule.plays.map((entry, i) =>
      i === at ? { ...entry, play: { kind: 'succeed' as const } } : entry,
    );
    assert.equal(
      await failsAs(kind, { ...schedule, plays }, checks, options),
      false,
      `the run fails with ${JSON.stringify(attempt)} succeeding`,
    );
  }
};

/** Fails once a kill landed after an effect reached the code host. */
const killedAfterAnEffect: ChaosChecks = {
  afterMove: ({ engine }) => {
    const kill = engine.kills.find(({ point }) => point === 'after an effect reached its target');
    assert.equal(kill, undefined, 'a driver was killed after an effect reached its target');
  },
};

/** Fails once a driver took a batch over from one that was killed and stayed down. */
const tookOverFromTheKilled: ChaosChecks = {
  afterMove: ({ engine }) => {
    const takeover = engine.takeovers.find(({ why }) => why === 'killed');
    assert.equal(takeover, undefined, 'a batch was taken over from a driver that was killed');
  },
};

const drivers = ['cellar', 'session'] as const;

/**
 * What a run that held left behind: its schedule, its events, the faults it reached, and what
 * the drivers did, which the events do not show (who started each attempt, who was down).
 */
interface Played {
  schedule: ChaosSchedule;
  events: string[];
  faults: string;
  did: string;
}

/** Plays `play` with two drivers, checking nothing, and returns what it did. */
const played = async (play: Parameters<typeof trialChaos>[1]): Promise<Played> => {
  let result: Played | undefined;
  const noting: ChaosChecks = {
    atEnd: ({ engine, scenario }) => {
      result = {
        schedule: {
          moves: scenario.moves.map((move, i) => ({ site: i + 1, move })),
          settleFrom: scenario.moves.length,
          plays: scenario.plays,
          faults: [...engine.faults],
        },
        events: engine.events().map(describeEvent),
        faults: JSON.stringify(engine.faults),
        did: JSON.stringify({
          acts: engine.acts,
          kills: engine.kills,
          downs: engine.downs,
          interjections: engine.interjections,
          stops: engine.stops,
          contests: engine.contests,
        }),
      };
    },
  };
  const failure = await trialChaos(dir.path, play, noting, { drivers });
  if (failure !== undefined) throw failure.error;
  assert.ok(result, 'the run came to rest');
  return result;
};

describe('a failing chaos run', () => {
  it('shrinks to the moves it fails by and the one kill, at the site it had', async () => {
    const found = await firstFailure(killedAfterAnEffect, scenarios);
    const shrunk = await shrinkChaos(dir.path, found, killedAfterAnEffect, scenarios);
    const { moves, faults } = shrunk.failure.schedule;
    assert.deepStrictEqual(
      faults.map(({ kind }) => kind),
      ['kill after an effect reached its target'],
    );
    const [kill] = faults;
    assert.ok(
      found.failure.schedule.faults.some((fault) => JSON.stringify(fault) === JSON.stringify(kill)),
      'the kill is the one the first run had, at its site',
    );
    assert.ok(moves.length < found.failure.schedule.moves.length, 'moves were removed');
    await isSmallest(found, shrunk, killedAfterAnEffect, scenarios);
  });

  it('with two drivers, keeps the kill and the downtime a takeover needs, and nothing else', async () => {
    const options = { ...scenarios, drivers };
    const found = await firstFailure(tookOverFromTheKilled, options);
    const shrunk = await shrinkChaos(dir.path, found, tookOverFromTheKilled, options);
    const kinds = shrunk.failure.schedule.faults.map(({ kind }) => kind);
    assert.ok(
      kinds.some((kind) => kind.startsWith('kill ')),
      `a kill is left: ${kinds.join(', ')}`,
    );
    assert.ok(kinds.includes('down'), `the downtime is left: ${kinds.join(', ')}`);
    assert.ok(
      shrunk.failure.schedule.faults.length < found.failure.schedule.faults.length,
      'faults were removed',
    );
    await isSmallest(found, shrunk, tookOverFromTheKilled, options);
  });

  it('replays a run from its own faults event for event, with faults of every kind', async () => {
    const kinds = new Set<string>();
    const wanted = ['kill', 'pause', 'first', 'down', 'stall', 'interject'];
    // The last `runs` of a dozen seeds, and seeds 10 to 12 at least, all of them in full: on
    // most, the pauses change nothing the drivers do (seed 10 is the first where they do), so a
    // replay that dropped them would pass without seed 10.
    for (
      let seed = Math.max(1, Math.min(10, dozen - runs + 1));
      seed <= dozen || (seed <= maxSeeds && wanted.some((k) => !kinds.has(k)));
      seed++
    ) {
      const first = await played({ seed });
      const again = await played({ schedule: first.schedule });
      assert.deepStrictEqual(again.events, first.events, `seed ${seed} appends the same events`);
      assert.equal(again.faults, first.faults, `seed ${seed} reaches the same faults`);
      assert.equal(again.did, first.did, `seed ${seed}'s drivers do the same`);
      for (const { kind } of first.schedule.faults) kinds.add(kind.split(' ')[0] ?? kind);
    }
    assert.deepStrictEqual(
      wanted.filter((kind) => !kinds.has(kind)),
      [],
    );
  });

  it('stops at its budget of runs and says so', async () => {
    const found = await firstFailure(killedAfterAnEffect, scenarios);
    const shrunk = await shrinkChaos(dir.path, found, killedAfterAnEffect, scenarios, 3);
    assert.equal(shrunk.runs, 3);
    assert.equal(shrunk.exhausted, true);
  });

  it('keeps a failure whose message names other batches and attempts as the same one', () => {
    const leases = (batch: string, attempts: [number, number]) =>
      new Error(`step ${batch} implement has live leases ${attempts.join(', ')}\nSeed 7`);
    assert.equal(failureKind(leases('2-1', [3, 4])), failureKind(leases('5-12', [1, 2])));
    assert.notEqual(
      failureKind(leases('2-1', [3, 4])),
      failureKind(new Error('step 2-1 plan has live leases 3, 4')),
    );
  });

  it('is reported with its seed and the schedule it shrank to', async () => {
    const { seed } = await firstFailure(killedAfterAnEffect, scenarios);
    await assert.rejects(
      checkSeed(dir.path, seed, killedAfterAnEffect, scenarios),
      (error: Error) => {
        assert.match(error.message, /^a driver was killed after an effect reached its target/);
        assert.match(
          error.message,
          new RegExp(
            `\\nSeed ${seed}, shrunk in \\d+ runs from \\d+ moves and \\d+ faults? to \\d+ moves? and 1 fault\\.`,
          ),
        );
        assert.match(
          error.message,
          /\n +1\. move \d+, cellar: killed after an effect reached its target/,
        );
        return true;
      },
    );
  });
});
