// The attempt worktrees across kills (#144, ADR 0037): the driver makes each attempt's worktree in
// an in-memory clone, records it, and cleans an ended batch's, killed while it makes, records and
// cleans them. No attempt runs without its worktree, nothing a live batch or a running attempt
// claims is removed, and nothing of an ended batch but its task tree's branch is left once the run
// is at rest. The run count is FOEDRUM_RUNS, as for restarts.test.ts.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { attemptKey } from '../../src/engine/attempt-key.ts';
import { attemptBranch } from '../../src/workspace/attempt-worktrees.ts';
import type { ChaosChecks, ChaosEngine, ChaosRun } from '../helpers/chaos.ts';
import { restsWithEffectsOnce } from '../helpers/chaos-checks.ts';
import { holdsAcrossKills, trialChaos } from '../helpers/chaos-shrink.ts';
import { chaosBase, chaosRepo, type FakeClone, hasEnded } from '../helpers/chaos-worktrees.ts';
import {
  generateScenario,
  human,
  type MoveSource,
  seededRandom,
} from '../helpers/event-sequences.ts';
import { running } from '../helpers/simulation.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';

let dir: TempDir;
before(() => {
  dir = makeTempDir('chaos-worktrees');
});
after(() => dir.remove());

/**
 * `seed`'s generated scenario, in which the terminal now and then cancels a batch while an attempt
 * of it runs, as ADR 0037 has a case for. Left alone, a run seldom does: an attempt that runs on
 * between moves hangs, and it is mostly Stuck before a cancel comes. A rewind of a batch that is no
 * sub-order names the clone's repository at a commit the clone has, so the next attempt starts
 * there (ADR 0066); the scenario's own rewinds name other repositories.
 */
const cancelling = (seed: number): MoveSource => {
  const scenario = generateScenario(seed);
  const random = seededRandom(seed ^ 0xca_9ce1);
  return {
    move: (state) => {
      const busy = [...state.batches.values()].filter((batch) =>
        running(batch).some((attempt) => attempt.phase === 'started' && attempt.abandoned !== true),
      );
      if (busy.length > 0 && random.chance(0.3)) {
        const { id } = random.pick(busy);
        return { kind: 'command', command: { kind: 'cancel', batchId: id, ...human } };
      }
      const next = scenario.move(state);
      if (next?.kind !== 'command' || next.command.kind !== 'rewind') return next;
      const issue = state.batches.get(next.command.batchId)?.issue;
      if (issue === undefined || state.subOrders.has(issue)) return next;
      return { ...next, command: { ...next.command, shas: { [chaosRepo]: chaosBase } } };
    },
    play: scenario.play,
  };
};

const options = { worktrees: true, moves: cancelling };

const cloneOf = (engine: ChaosEngine): FakeClone => {
  assert.ok(engine.clone, 'the run has a clone');
  return engine.clone;
};

/** No attempt started without its worktree, and nothing claimed was removed. */
const keptItsClaims = ({ engine }: ChaosRun): void => {
  assert.deepStrictEqual(cloneOf(engine).violations, [], 'the worktrees kept their claims');
};

/**
 * Nothing is left in the clone of a batch that has ended, or that the state does not know, but
 * the branch of its task tree: no push recorded it, since the runs open no pull request, and every
 * fake brewer commits, so that branch is the only ref to its commits (ADR 0084).
 */
const nothingLeftOfEnded = ({ engine }: ChaosRun): void => {
  const clone = cloneOf(engine);
  const { batches } = engine.state();
  for (const batchId of clone.batches()) {
    assert.ok(
      batches.has(batchId),
      `the clone has worktrees of ${batchId}, which the state does not know`,
    );
  }
  // Every ended batch, also one the clone has nothing of: its task tree's branch must be there.
  for (const [batchId, batch] of batches) {
    if (!hasEnded(batch)) continue;
    const { taskTree } = batch;
    const kept = taskTree?.kind === 'attempt' ? [attemptBranch({ batchId, ...taskTree })] : [];
    assert.deepStrictEqual(
      clone.leftovers(batchId),
      { records: [], folders: [], branches: kept },
      `nothing is left of the ended batch ${batchId} but its task tree's branch`,
    );
  }
};

/**
 * Every attempt starts at the commits of the attempts that succeeded before it in its batch, or of
 * the rewind after them, across kills: none of them is lost, none added twice (ADR 0066). The
 * checks' own rule, read from the events in order, not the fold's.
 */
const startsAtTheTaskTree = ({ engine }: ChaosRun): void => {
  const clone = cloneOf(engine);
  // By batch: the commit its next attempt starts at, or null after a rewind of another repository.
  const tips = new Map<string, string | null>();
  const withWorktree = new Set<string>();
  for (const event of engine.events()) {
    switch (event.type) {
      case 'step.started': {
        const { batchId, stepId, attempt } = event;
        // A resumed attempt goes on in the worktree it continues, at its branch's tip (ADR 0117).
        if (event.worktree === undefined) {
          if (event.session?.resumes !== undefined) {
            withWorktree.add(attemptKey.encode({ batchId, stepId, attempt }));
          }
          break;
        }
        withWorktree.add(attemptKey.encode({ batchId, stepId, attempt }));
        const tip = tips.get(batchId);
        if (tip === null) break;
        assert.equal(
          event.worktree.commit,
          tip ?? chaosBase,
          `${stepId}#${attempt} of ${batchId} starts at the commits of the steps before it`,
        );
        break;
      }
      case 'step.finished': {
        const { batchId, stepId, attempt } = event;
        const key = attemptKey.encode({ batchId, stepId, attempt });
        const sha = clone.committed(key);
        if (event.outcome.kind === 'succeeded' && withWorktree.has(key) && sha !== undefined) {
          tips.set(batchId, sha);
        }
        break;
      }
      case 'batch.rewound':
        tips.set(event.batchId, event.shas[chaosRepo] ?? null);
        break;
      default:
        break;
    }
  }
};

const checks: ChaosChecks = {
  afterMove: (run, move, survived) => {
    keptItsClaims(run);
    startsAtTheTaskTree(run);
    restsWithEffectsOnce.afterMove(run, move, survived);
  },
  atEnd: (run) => {
    keptItsClaims(run);
    startsAtTheTaskTree(run);
    nothingLeftOfEnded(run);
    restsWithEffectsOnce.atEnd(run);
  },
};

const killedAt = (engine: ChaosEngine, point: string): boolean =>
  engine.kills.some((kill) => kill.point === point);

/** What the runs with worktrees must reach between them, each asked of one finished run. */
const goals: Readonly<Record<string, (engine: ChaosEngine) => boolean>> = {
  'killed while making a worktree': (engine) => killedAt(engine, 'while making a worktree'),
  // The attempt stays scheduled, and its next start reuses the untouched worktree (ADR 0037).
  'killed between making a worktree and recording it, which the next start reused': (engine) =>
    killedAt(engine, 'after a worktree was made') &&
    cloneOf(engine).made.some(({ how }) => how === 'reused'),
  'killed while cleaning worktrees': (engine) => killedAt(engine, 'while cleaning worktrees'),
  // A kill between two steps: the next step starts at the commits a brewer of the killed driver
  // made (ADR 0066).
  // A rewind of the clone's repository: the next attempt starts at its commit.
  'an attempt started at the commit of a rewind': (engine) => {
    const rewound = new Set<string>();
    return engine.events().some((event) => {
      if (event.type === 'batch.rewound' && event.shas[chaosRepo] !== undefined) {
        rewound.add(event.batchId);
      }
      return (
        event.type === 'step.started' && event.worktree !== undefined && rewound.has(event.batchId)
      );
    });
  },
  'a step started at the commits of a step the killed driver ran': (engine) =>
    cloneOf(engine).made.some(({ how, acrossKill }) => how !== 'refused' && acrossKill === true),
  // A kill between a batch's end and its cleanup, or part-way through one: the start repairs it.
  'what a kill left of an ended batch removed by the repair at the next start': (engine) =>
    cloneOf(engine).cleaned.some(({ batchId, done }) => batchId === undefined && done.length > 0),
  // A retry goes on in the session and worktree of the attempt before it (ADR 0117).
  'a retry resumed the session of the attempt before it, in the worktree that attempt made': (
    engine,
  ) =>
    engine
      .events()
      .some((event) => event.type === 'step.started' && event.session?.resumes !== undefined),
  // Lost or ended before claude's init: no session to resume, so it starts fresh and says why.
  'a retry that had no session to resume started fresh, saying why': (engine) =>
    engine
      .events()
      .some((event) => event.type === 'step.started' && event.session?.fallback !== undefined),
  // Its worktree stays under the attempt's lease at first, and goes once the lease does.
  'a batch that ended while an attempt ran kept its worktree, which went later': (engine) =>
    cloneOf(engine).cleaned.some(
      ({ batchId, kept }) =>
        batchId !== undefined && kept.some((line) => line.endsWith('holds a live lease')),
    ),
};

describe('attempt worktrees across kills', () => {
  it('every attempt runs in its worktree, nothing claimed is removed, nothing of an ended batch is left', () =>
    holdsAcrossKills(dir.path, checks, options));

  /** How many seeds the coverage test may try before it fails. */
  const maxSeeds = 30;

  it('reach every worktree case of ADR 0037', async () => {
    const wanted = Object.keys(goals);
    const seen = new Set<string>();
    // Fixed seeds, the first ones until every goal is reached: what the harness reaches does not
    // depend on FOEDRUM_SEED.
    for (let seed = 1; seed <= maxSeeds && wanted.some((what) => !seen.has(what)); seed++) {
      // Checked as well: a run that reaches a case must also keep the rules there.
      const reaching: ChaosChecks = {
        ...checks,
        atEnd: (run) => {
          checks.atEnd?.(run);
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
