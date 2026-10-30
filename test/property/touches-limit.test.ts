// The touches limit (#566) over generated breakdowns, through the intake's own pass: never two
// Ordered or Brewing batches whose `touches` overlap unless both were before the pass, and every
// ready sub-order that fits the free capacity and overlaps no Ordered or Brewing batch starts. A
// sub-order whose issue has no recipe label stays Ordered, as one whose route is held does. The oracle takes the
// paths from the generated plan, not the fold, and decides an overlap by its own rule.

import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createCommandLog } from '../../src/engine/command-log.ts';
import type { Ending } from '../../src/engine/decide.ts';
import { createIntake, intakeQueue, type TargetTracker } from '../../src/engine/intake.ts';
import type { Claimant, TargetIssue } from '../../src/engine/issue-claims.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import { seededRandom } from '../helpers/event-sequences.ts';
import { fakeGitHub } from '../helpers/fake-github.ts';
import { fakeRecipe, fakeRecipes } from '../helpers/fake-recipes.ts';
import { forEachSeedAsync } from '../helpers/property.ts';

const brewery = 'alice/brewery';
const now = new Date('2026-10-30T09:00:00.000Z');
const claimant: Claimant = { brewery, login: 'alice' };
const recipes = fakeRecipes({ half: fakeRecipe({ steps: ['plan'] }) });
const succeeded: Ending = {
  kind: 'succeeded',
  output: { status: 'done', summary: 'Done', assumptions: [] },
};
/** Files and folders that nest in each other, and a name that only begins like a folder. */
const paths = [
  'src/a.ts',
  'src/dir',
  'src/dir/x.ts',
  'src/dir/sub/y.ts',
  'src/dir-extra/z.ts',
  'docs',
  'docs/readme.md',
];
const repos = ['acme/web', 'acme/Web', 'acme/api'];

interface Plan {
  repo: string;
  touches: string[];
}

const under = (path: string, folder: string): boolean =>
  path === folder || path.startsWith(`${folder}/`);
const clash = (one: Plan, other: Plan): boolean =>
  one.repo.toLowerCase() === other.repo.toLowerCase() &&
  one.touches.some((a) => other.touches.some((b) => under(a, b) || under(b, a)));

it('a pass never brews two sub-orders whose touches overlap, and starts every one that fits', async () => {
  await forEachSeedAsync(30, async (seed) => {
    const random = seededRandom(seed);
    const store = openSqliteEventStore(':memory:');
    try {
      const log = createCommandLog({ store, recipes });
      const accept = (command: Parameters<typeof log.issue>[0]): void => {
        const decision = log.issue(command, now);
        assert.equal(decision.kind, 'accepted', JSON.stringify(decision));
      };
      const route = (batchId: string): void =>
        accept({ kind: 'route', batchId, recipe: 'half', reason: 'label', source: 'label' });
      // Some sub-orders' issues have no recipe label yet: their batches stay Ordered.
      const unlabelled = new Set<number>();
      const issue = (number: number): TargetIssue => ({
        number,
        state: 'open',
        pullRequest: false,
        labels: unlabelled.has(number) ? [] : ['recipe:half'],
        milestone: undefined,
        assignees: [],
        author: 'alice',
        created: new Date(Date.UTC(2026, 9, 30, 8, number)).toISOString(),
      });

      // The breakdown of order #1: what each sub-order touches, none for some.
      const plans = new Map<number, Plan>();
      for (let n = 2 + random.int(7), number = 10; n > 0; n--, number++) {
        const touches = random.chance(0.2)
          ? []
          : Array.from({ length: 1 + random.int(3) }, () => random.pick(paths));
        plans.set(number, { repo: random.pick(repos), touches });
        if (random.chance(0.25)) unlabelled.add(number);
      }
      accept({ kind: 'order', batchId: '1-1', order: { issue: 1 } });
      route('1-1');
      accept({
        kind: 'record',
        event: {
          type: 'order.decomposed',
          batchId: '1-1',
          subOrders: [...plans].map(([number, { repo, touches }]) =>
            touches.length === 0 ? { issue: number, repo } : { issue: number, repo, touches },
          ),
          dependencies: [],
        },
      });
      // Some are ordered already, whatever they touch, and brew unless unlabelled.
      for (const number of plans.keys()) {
        if (!random.chance(0.2)) continue;
        accept({
          kind: 'order',
          batchId: `${number}-1`,
          order: { issue: number },
          parentBatchId: '1-1',
        });
        if (!unlabelled.has(number)) route(`${number}-1`);
      }
      const listed = [1, ...plans.keys()].map(issue);
      const tracker: TargetTracker = {
        issues: async (repo) => (repo === brewery ? listed : []),
        pullRequest: async () => 'open',
      };
      const busyIn = (state: ReturnType<typeof log.state>): number =>
        [...state.batches.values()].filter(
          ({ lane }) => lane.kind === 'ordered' || lane.kind === 'brewing',
        ).length;
      const free = random.int(6);
      const capacity = busyIn(log.state()) + free;
      const intake = createIntake({
        log,
        brewery,
        tracker,
        claims: fakeGitHub().host,
        claimant,
        authors: ['alice'],
        repositories: [],
        capacity,
        clock: () => now,
      });
      const plansIn = (
        state: ReturnType<typeof log.state>,
        kinds: readonly string[],
      ): Map<number, Plan> =>
        new Map(
          [...state.batches.values()].flatMap(({ issue: number, lane }) => {
            const plan = plans.get(number);
            return kinds.includes(lane.kind) && plan !== undefined ? [[number, plan] as const] : [];
          }),
        );
      const activePlans = (state: ReturnType<typeof log.state>) =>
        plansIn(state, ['ordered', 'brewing']);

      for (let round = 1; round <= 2; round++) {
        const before = log.state();
        const note = `seed ${seed}, round ${round}, free ${free}, plans ${JSON.stringify([...plans])}`;
        const queue = intakeQueue(
          before,
          { brewery: listed, repositories: [] },
          { authors: ['alice'], claimant },
        );
        const blockers = [...activePlans(before).values()];
        const slots = Math.max(0, capacity - busyIn(before));
        await intake.poll();
        const after = log.state();

        // Walk the queue as the oracle: a sub-order starts while a slot is free and no Ordered,
        // Brewing or just started sub-order overlaps it.
        let started = 0;
        for (const { subOrder } of queue) {
          const number = subOrder?.issue;
          const plan = number === undefined ? undefined : plans.get(number);
          assert.ok(number !== undefined && plan !== undefined, note);
          const fits = started < slots && !blockers.some((other) => clash(plan, other));
          assert.equal(after.batches.has(`${number}-1`), fits, `${number}-1 in ${note}`);
          if (!fits) continue;
          started++;
          blockers.push(plan);
        }

        // Never two Ordered or Brewing batches that overlap, unless both were before this pass.
        const activeBefore = activePlans(before);
        const active = [...activePlans(after)];
        for (const [at, [number, plan]] of active.entries()) {
          for (const [other, otherPlan] of active.slice(at + 1)) {
            if (activeBefore.has(number) && activeBefore.has(other)) continue;
            assert.ok(!clash(plan, otherPlan), `${number} and ${other} brew together in ${note}`);
          }
        }

        // Some of what brews goes on tap, which frees what it held.
        for (const number of plansIn(after, ['brewing']).keys()) {
          if (!random.chance(0.5)) continue;
          const event = {
            type: 'step.started',
            batchId: `${number}-1`,
            stepId: 'plan',
            attempt: 1,
          } as const;
          accept({ kind: 'record', event });
          accept({
            kind: 'finish',
            batchId: `${number}-1`,
            stepId: 'plan',
            attempt: 1,
            ending: succeeded,
          });
        }
      }
    } finally {
      store.close();
    }
  });
});
