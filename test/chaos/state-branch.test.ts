// The state branch across kills (#144, ADR 0011, ADR 0024): every driver process starts on the
// state branch, and its supervisor flushes the log to it, killed while it writes the log files,
// before the push reached the remote and after, before the pushed-through marker was written. The
// remote always holds the store's first events, each once, the marker never claims more than the
// remote has, no start stops the engine, and a flush at rest pushes every event. The run count is
// FOEDRUM_RUNS, as for restarts.test.ts.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { ChaosChecks, ChaosEngine, ChaosRun, Life } from '../helpers/chaos.ts';
import { restsWithEffectsOnce } from '../helpers/chaos-checks.ts';
import { holdsAcrossKills, trialChaos } from '../helpers/chaos-shrink.ts';
import type { FakeStateBranch } from '../helpers/chaos-state-branch.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';

let dir: TempDir;
before(() => {
  dir = makeTempDir('chaos-state-branch');
});
after(() => dir.remove());

const options = { stateBranch: true };

const branchOf = (engine: ChaosEngine): FakeStateBranch => {
  assert.ok(engine.branch, 'the run has a state branch');
  return engine.branch;
};

/** An event as JSON, so one read from the branch and one from the store compare. */
const asJson = (event: unknown): unknown => JSON.parse(JSON.stringify(event));

/** The ids of the events on the remote, after checking that it holds a prefix of the store's. */
const remoteIsAPrefix = ({ engine }: ChaosRun): number[] => {
  const lines = branchOf(engine).remoteLines();
  const ids = lines.map(({ id }) => id).sort((a, b) => a - b);
  assert.deepStrictEqual(
    ids,
    ids.map((_, i) => i + 1),
    'the remote holds the events from 1 on, each once',
  );
  const stored = new Map(
    engine
      .store()
      .eventsAfter(0)
      .map(({ id, event }) => [id, event]),
  );
  for (const { path, id, event } of lines) {
    assert.deepStrictEqual(event, asJson(stored.get(id)), `event ${id} in ${path} is the store's`);
  }
  return ids;
};

/** The pushed-through marker names a commit on the remote, and no event beyond it. */
const markerOnTheRemote = ({ engine }: ChaosRun, remote: readonly number[]): void => {
  const marker = engine.store().pushedThrough();
  if (marker === undefined) return;
  assert.ok(branchOf(engine).onRemote(marker.commit), `the marker's ${marker.commit} is pushed`);
  assert.ok(
    marker.eventId <= (remote.at(-1) ?? 0),
    `the marker's event ${marker.eventId} is on the remote`,
  );
};

/**
 * No start stopped the engine or restored a store that kept its events, and each left what was
 * committed before it on the remote (ADR 0024).
 */
const startsGoOn = ({ engine }: ChaosRun): void => {
  const branch = branchOf(engine);
  const starts = branch.starts.filter(
    ({ decision }) => decision !== 'ready' && decision !== 'flush',
  );
  assert.deepStrictEqual(starts, [], 'every start was ready or flushed');
  assert.deepStrictEqual(branch.behind, [], 'every start brought the branch in line');
};

// The last event each run had committed before its current move began.
const committedBefore = new WeakMap<ChaosEngine, number>();

/** A process beside the drivers that is never killed. */
const immortal: Life = { driver: 'checks', dead: false, point: () => {}, alive: () => {} };

const checks: ChaosChecks = {
  afterMove: (run, move, survived) => {
    const remote = remoteIsAPrefix(run);
    markerOnTheRemote(run, remote);
    startsGoOn(run);
    // A tick the driver lived through flushed what was committed before it (ADR 0024).
    const { engine } = run;
    if (move.kind === 'tick' && survived) {
      const last = committedBefore.get(engine) ?? 0;
      assert.ok(
        (remote.at(-1) ?? 0) >= last,
        `after a tick, the remote holds the ${last} events committed before it`,
      );
    }
    committedBefore.set(engine, engine.store().lastEventId());
    restsWithEffectsOnce.afterMove(run, move, survived);
  },
  atEnd: async (run) => {
    restsWithEffectsOnce.atEnd(run);
    // At rest, a flush pushes every event, whatever the kills left behind.
    const { engine } = run;
    await branchOf(engine).handle(immortal, engine.store()).flush();
    const remote = remoteIsAPrefix(run);
    assert.equal(remote.length, engine.store().lastEventId(), 'the remote holds every event');
    assert.equal(
      engine.store().pushedThrough()?.eventId,
      remote.at(-1),
      'the marker is at the end',
    );
    startsGoOn(run);
  },
};

const killedAt = (engine: ChaosEngine, point: string): boolean =>
  engine.kills.some((kill) => kill.point === point);

/** Whether a start right after a kill at `point` decided `decision`. */
const startedAfter = (engine: ChaosEngine, point: string, decision: string): boolean =>
  branchOf(engine).starts.some((start) => start.after === point && start.decision === decision);

/** What the runs with a state branch must reach between them, each asked of one finished run. */
const goals: Readonly<Record<string, (engine: ChaosEngine) => boolean>> = {
  'killed while writing the log': (engine) => killedAt(engine, 'while writing the log'),
  // The commit is local; the next start pushes it (the remote is at the marker's commit).
  'killed before the push reached the remote, and the next start flushed': (engine) =>
    startedAfter(engine, 'before the push reached the remote', 'flush'),
  // The remote has events the marker does not name; the next start checks the files and pushes.
  'killed after the push reached the remote, before its marker, and the next start flushed': (
    engine,
  ) => startedAfter(engine, 'after the push reached the remote', 'flush'),
  'a start with everything pushed': (engine) =>
    branchOf(engine).starts.some(({ decision }) => decision === 'ready'),
};

describe('the state branch across kills', () => {
  it('holds the store’s first events once, never ahead of its marker, and every event at rest', () =>
    holdsAcrossKills(dir.path, checks, options));

  /** How many seeds the coverage test may try before it fails. */
  const maxSeeds = 30;

  it('reach every state branch case', async () => {
    const wanted = Object.keys(goals);
    const seen = new Set<string>();
    // Fixed seeds, the first ones until every goal is reached: what the harness reaches does not
    // depend on FOEDRUM_SEED.
    for (let seed = 1; seed <= maxSeeds && wanted.some((what) => !seen.has(what)); seed++) {
      // Checked as well: a run that reaches a case must also keep the rules there.
      const reaching: ChaosChecks = {
        ...checks,
        atEnd: async (run) => {
          await checks.atEnd?.(run);
          for (const [what, reached] of Object.entries(goals)) {
            if (reached(run.engine)) seen.add(what);
          }
        },
      };
      const failure = await trialChaos(dir.path, { seed }, reaching, options);
      if (failure !== undefined) throw failure.error;
    }
    assert.deepStrictEqual(
      wanted.filter((what) => !seen.has(what)),
      [],
    );
  });
});
