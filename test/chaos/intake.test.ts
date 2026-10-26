// The intake killed between an order and its route (#107, ADR 0068): a pass orders labelled Brewery
// issues and claimed target issues, then routes them by label (a claimed one by its Brewery issue's,
// ADR 0156), and is killed after one of its orders committed. What survives is the store and the
// fake GitHub. A restarted intake routes the batches the dead pass left Ordered and never orders an
// issue twice; an intake that never comes
// back leaves them for the supervisor, which makes each Stuck on routing in its first tick after
// the deadline (ADR 0032). The run count is FOEDRUM_RUNS (a few in npm run check, more in CI).

import assert from 'node:assert/strict';
import { it } from 'node:test';
import { type CommandLog, createCommandLog } from '../../src/engine/command-log.ts';
import { effectKey } from '../../src/engine/effect-key.ts';
import type { EventStore } from '../../src/engine/event-store.ts';
import { createIntake, type TargetTracker } from '../../src/engine/intake.ts';
import { orderEffects, type TargetIssue } from '../../src/engine/issue-claims.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import { createSupervisor } from '../../src/engine/supervisor-loop.ts';
import { type Random, seededRandom } from '../helpers/event-sequences.ts';
import { fakeGitHub } from '../helpers/fake-github.ts';
import { createdOf } from '../helpers/fake-github-api.ts';
import { fakeRecipe, fakeRecipes } from '../helpers/fake-recipes.ts';
import { forEachSeedAsync } from '../helpers/property.ts';

const brewery = 'ann/brewery';
const web = 'acme/web';
const t0 = new Date('2026-10-17T09:00:00.000Z');
const routingMs = 3_600_000;
const recipes = fakeRecipes({ half: fakeRecipe({ steps: ['plan'] }) });

/** What an issue's labels ask for: one recipe the Brewery has, none, one it lacks, or two. */
type Kind = 'half' | 'none' | 'unknown' | 'two';
const labelsOf: Record<Kind, string[]> = {
  half: ['recipe:half'],
  none: [],
  unknown: ['recipe:pint'],
  two: ['recipe:half', 'recipe:stout'],
};

interface Planned {
  repo: string;
  number: number;
  kind: Kind;
}

class IntakeKilled extends Error {
  constructor() {
    super('The intake was killed');
    this.name = 'IntakeKilled';
  }
}

/** A command log that dies once its `after`-th command was accepted: nothing is written after. */
const killable = (log: CommandLog, after: number): CommandLog => {
  let accepted = 0;
  let dead = false;
  const alive = (): void => {
    if (dead) throw new IntakeKilled();
  };
  return {
    state: () => {
      alive();
      return log.state();
    },
    issue: (command, now, also) => {
      alive();
      const decision = log.issue(command, now, also);
      if (
        decision.kind === 'accepted' &&
        typeof command !== 'function' &&
        command.kind === 'order' &&
        ++accepted === after
      ) {
        dead = true;
      }
      return decision;
    },
  };
};

/** Brewery issues with a recipe label (a Brewery issue without one is no order) and target issues. */
const plan = (random: Random): Planned[] => {
  const planned: Planned[] = [];
  const brewed = 1 + random.int(4);
  for (let number = 1; number <= brewed; number++) {
    planned.push({ repo: brewery, number, kind: random.pick(['half', 'unknown', 'two'] as const) });
  }
  const targets = random.int(3);
  for (let number = 1; number <= targets; number++) {
    planned.push({ repo: web, number, kind: random.pick(['half', 'none', 'unknown'] as const) });
  }
  return planned;
};

/** The Brewery issue the driver opens for the claimed target issue `number` (ADR 0144). */
const orderOf = (number: number): number => 100 + number;

/**
 * The open issues of each repository. A claimed target issue is routed by its Brewery issue, which
 * carries what the plan asks for; the target issue itself always carries `recipe:half`, which never
 * counts (ADR 0156). `opened`: the target issues whose Brewery issue the driver opened.
 */
const tracker = (planned: readonly Planned[], opened: ReadonlySet<number>): TargetTracker => {
  const listed = (number: number, labels: string[]): TargetIssue => ({
    number,
    state: 'open',
    pullRequest: false,
    labels,
    milestone: undefined,
    assignees: [],
    author: 'ann',
    created: createdOf(number),
  });
  return {
    issues: async (repo) =>
      repo === web
        ? planned
            .filter((each) => each.repo === web)
            .map(({ number }) => listed(number, ['foedrum', 'recipe:half']))
        : planned.flatMap(({ repo: from, number, kind }) => {
            if (from === brewery) return [listed(number, labelsOf[kind])];
            return opened.has(number) ? [listed(orderOf(number), labelsOf[kind])] : [];
          }),
    pullRequest: async () => 'open',
  };
};

const run = async (seed: number): Promise<void> => {
  const random = seededRandom(seed);
  const planned = plan(random);
  const store: EventStore = openSqliteEventStore(':memory:');
  const github = fakeGitHub();
  const intakeOf = (log: CommandLog, at: Date, opened: ReadonlySet<number> = new Set()) =>
    createIntake({
      log,
      brewery,
      tracker: tracker(planned, opened),
      claims: github.host,
      claimant: { brewery, login: 'ann' },
      authors: ['ann'],
      repositories: [{ repo: web, alias: 'web', filter: { labels: ['foedrum'] } }],
      capacity: 20,
      clock: () => at,
    });
  const fresh = () => createCommandLog({ store, recipes, routingMs });
  const batches = () => [...fresh().state().batches.values()];
  const batchOf = ({ repo, number }: Planned) =>
    batches().filter((batch) => (batch.repo ?? brewery) === repo && batch.issue === number);
  try {
    // Killed after one of its orders committed: before its route, or before the next order.
    const killAfter = 1 + random.int(planned.length);
    await intakeOf(killable(fresh(), killAfter), t0)
      .poll()
      .catch((error: unknown) => {
        if (!(error instanceof IntakeKilled)) throw error;
      });
    const killed = batches();
    assert.ok(killed.length >= 1, 'the killed pass committed an order');
    assert.ok(
      killed.every((batch) => batch.lane.kind === 'ordered' || batch.lane.kind === 'brewing'),
    );

    const restarted = random.int(2) === 1;
    if (restarted) {
      // Back before the routing deadline: the next pass routes what the dead one left Ordered. The
      // driver opened the Brewery issue of each claimed batch the dead pass ordered, and of none
      // the next pass orders (ADR 0144).
      const at = new Date(t0.getTime() + random.int(routingMs));
      const opened = new Set<number>();
      for (const batch of batches()) {
        if (batch.repo === undefined) continue;
        opened.add(batch.issue);
        const key = effectKey.encode({ batchId: batch.id, effect: orderEffects.open });
        const event = { type: 'effect.applied', key, result: orderOf(batch.issue) } as const;
        assert.equal(fresh().issue({ kind: 'record', event }, at).kind, 'accepted');
      }
      await intakeOf(fresh(), at, opened).poll();
      for (const each of planned) {
        const found = batchOf(each);
        assert.equal(found.length, 1, `${each.repo}#${each.number} has one batch`);
        const lane = found[0]?.lane.kind;
        // A claimed batch whose Brewery issue is not open yet waits for it, whatever its target
        // issue carries.
        const routable = each.repo === brewery || opened.has(each.number);
        assert.equal(
          lane,
          routable && each.kind === 'half' ? 'brewing' : 'ordered',
          `${each.repo}#${each.number}`,
        );
      }
      // The Brewery issue of a claimed batch is never ordered as one of the Brewery's own.
      assert.ok(batches().every((batch) => batch.issue < 100));
    }

    // The supervisor's first tick after the last routing deadline: no batch is left Ordered.
    const deadlines = batches().flatMap(({ lane }) =>
      lane.kind === 'ordered' ? [Date.parse(lane.routeBy)] : [],
    );
    const tickAt = new Date(Math.max(t0.getTime(), ...deadlines) + 1 + random.int(5000));
    const ordered = batches().flatMap(({ id, lane }) => (lane.kind === 'ordered' ? [id] : []));
    const supervisor = createSupervisor({
      store,
      stateBranch: { flush: async () => ({ kind: 'unchanged' }) },
      recipes,
      progress: { progress: () => undefined },
      clock: () => tickAt,
      routingMs,
    });
    try {
      await supervisor.tick();
    } finally {
      supervisor.stop();
    }
    const after = new Map(batches().map((batch) => [batch.id, batch.lane]));
    for (const batchId of ordered) {
      const lane = after.get(batchId);
      assert.ok(
        lane?.kind === 'stuck' && lane.reason.kind === 'routing',
        `${batchId} is ${lane?.kind} one tick after its routing deadline`,
      );
    }
    assert.ok([...after.values()].every(({ kind }) => kind !== 'ordered'));
    for (const each of planned) {
      assert.ok(batchOf(each).length <= 1, `${each.repo}#${each.number} was never ordered twice`);
    }
  } finally {
    store.close();
  }
};

it('an intake killed between an order and its route: routed on restart, never ordered twice, else Stuck on routing in one tick', () =>
  forEachSeedAsync(30, run));
