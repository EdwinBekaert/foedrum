// What the chaos harness (#15) reaches: kills at every kind of point, and what a restart must
// recover from. Without this, a harness whose kills never land in the right places would pass.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
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
} from '../helpers/event-sequences.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';

let dir: TempDir;
before(() => {
  dir = makeTempDir('chaos-kills');
});
after(() => dir.remove());

let runs = 0;

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
  const engine = openChaosEngine(path, (attempt) => source.play(attempt), killPlan(seed), host);
  try {
    const run: ChaosRun = { engine, host, scenario, moves: [] };
    await runChaos(run, source);
    return what(run);
  } finally {
    engine.close();
  }
};

describe('chaos runs', () => {
  it('kill the engine at every kind of point, and restart into what it must recover from', async () => {
    const seen = new Set<string>();
    // Fixed seeds: what the harness reaches does not depend on FOEDRUM_SEED.
    for (let seed = 1; seed <= 12; seed++) {
      await chaos(seed, { moves: [], plays: [] }, false, ({ engine }) => {
        for (const { point } of engine.kills) seen.add(`killed ${point}`);
        if (engine.found > 0) seen.add('an effect found on the code host, not applied again');
        const killedAt = new Set(engine.kills.map(({ move }) => move));
        if (killedAt.size < engine.kills.length) seen.add('killed again soon after a restart');
        // A restart expires the killed run's leases at once, so the reason names its time.
        const restarted = engine.restarts.map((at) => `expired at ${at.toISOString()}`);
        for (const event of engine.events()) {
          if (event.type !== 'step.finished' || event.outcome.kind !== 'failed') continue;
          const { reason } = event.outcome;
          if (
            reason.startsWith('the attempt was lost') &&
            restarted.some((expiry) => reason.endsWith(expiry))
          ) {
            seen.add('an attempt of the killed run lost and retried');
          }
        }
      });
    }
    const wanted = [
      ...killPoints.map((point) => `killed ${point}`),
      'an effect found on the code host, not applied again',
      'killed again soon after a restart',
      'an attempt of the killed run lost and retried',
    ];
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
