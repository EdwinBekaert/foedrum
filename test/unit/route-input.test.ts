// What an attempt a route schedules gets (#341, ADR 0128): the failed reading of the check that
// sent it back, or the findings of the out doc that blocked, as one tagged input. Pure: the events
// are folded, the out doc's read is given.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  MAX_ROUTE_INPUT_BYTES,
  type PlannedRoute,
  routeInput,
  routeOf,
} from '../../src/brewers/attempt-plan.ts';
import { fold } from '../../src/engine/fold.ts';
import type { Event, GravityReading } from '../../src/schemas/events.ts';

const deadlineAt = '2026-10-22T13:00:00.000Z';
const worktreeOf = (name: string) => ({
  repo: 'acme/api',
  path: join('/work', name),
  branch: `foedrum/12-1/${name}`,
  commit: 'c'.repeat(40),
});
const outDocs: Record<string, string> = { implement: 'implement.md', gauge: 'gauge.md' };
const outDocOf = (stepId: string): string | undefined => outDocs[stepId];

const ordered: Event[] = [
  { type: 'batch.ordered', batchId: '12-1', order: { issue: 12 }, routeBy: deadlineAt },
  { type: 'batch.recipe_chosen', batchId: '12-1', recipe: 'nip', reason: 'label', source: 'label' },
];

/** One attempt of `stepId` from schedule to finish, in a worktree of its own. */
const attempt = (
  stepId: string,
  number: number,
  finished: Partial<Extract<Event, { type: 'step.finished' }>> = {},
  route?: { from: string; why: 'failed' | 'findings' },
): Event[] => {
  const ref = { batchId: '12-1', stepId, attempt: number };
  return [
    { type: 'step.scheduled', ...ref, deadlineAt, ...(route === undefined ? {} : { route }) },
    { type: 'step.started', ...ref, worktree: worktreeOf(`${stepId}-${number}`) },
    {
      type: 'step.finished',
      ...ref,
      outcome: { kind: 'succeeded', output: null },
      ...finished,
    },
  ];
};

/** The attempt of `stepId` a route scheduled, started and not finished. */
const routed = (stepId: string, number: number, from: string, why: 'failed' | 'findings') =>
  attempt(stepId, number, {}, { from, why }).slice(0, 2);

const failedTest = (tail: string): GravityReading => ({
  result: 'exited',
  check: 'test',
  command: 'npm test',
  exitCode: 1,
  tail,
});
const greenFailed = (tail: string): Partial<Extract<Event, { type: 'step.finished' }>> => ({
  outcome: {
    kind: 'failed',
    retryable: false,
    reason: 'the check "test" (npm test) failed with exit code 1',
  },
  readings: [
    { result: 'exited', check: 'build', command: 'npm run build', exitCode: 0, tail: 'built' },
    failedTest(tail),
  ],
});

const batchOf = (events: readonly Event[]) => {
  const found = fold([...ordered, ...events]).batches.get('12-1');
  assert.ok(found !== undefined);
  return found;
};

const planned = (events: readonly Event[], stepId: string, number: number) =>
  routeOf(batchOf(events), { batchId: '12-1', stepId, attempt: number }, outDocOf);

describe('routeOf', () => {
  it("gives an attempt an onFail route scheduled the failed check's name, exit code and tail", () => {
    const route = planned(
      [
        ...attempt('implement', 1),
        ...attempt('green', 1, greenFailed('not ok 1 - adds the --json flag')),
        ...routed('implement', 2, 'green', 'failed'),
      ],
      'implement',
      2,
    );
    assert.ok(route !== undefined, 'the routed attempt gets no route input');
    assert.deepEqual(route.source, {
      kind: 'route',
      step: 'implement',
      from: 'green',
      why: 'failed',
    });
    assert.equal(route.outDoc, undefined);
    assert.match(route.text, /the check "test" \(npm test\) failed with exit code 1/);
    assert.match(route.text, /not ok 1 - adds the --json flag/);
    // A check that passed is not why the step runs again.
    assert.doesNotMatch(route.text, /npm run build|built/);
  });

  it('carries only the reading of the round that routed it, not an earlier one', () => {
    const route = planned(
      [
        ...attempt('implement', 1),
        ...attempt('green', 1, greenFailed('not ok 1 - the first round')),
        ...attempt('implement', 2, {}, { from: 'green', why: 'failed' }),
        ...attempt('green', 2, greenFailed('not ok 2 - the second round')),
        ...routed('implement', 3, 'green', 'failed'),
      ],
      'implement',
      3,
    );
    assert.match(route?.text ?? '', /the second round/);
    assert.doesNotMatch(route?.text ?? '', /the first round/);
  });

  it('gives nothing new to an attempt no route scheduled, after a round that was routed', () => {
    const events = [
      ...attempt('implement', 1),
      ...attempt('green', 1, greenFailed('not ok 1 - adds the --json flag')),
      ...attempt(
        'implement',
        2,
        { outcome: { kind: 'failed', retryable: true, reason: 'crashed' } },
        { from: 'green', why: 'failed' },
      ),
      ...attempt('implement', 3).slice(0, 2),
    ];
    assert.equal(planned(events, 'implement', 3), undefined);
    assert.equal(planned(attempt('implement', 1).slice(0, 2), 'implement', 1), undefined);
  });

  it('leaves out a reason line that looks like a secret (#188)', () => {
    const token = `ghp_${'a1B2c3D4e5'.repeat(4)}`.slice(0, 40);
    const route = planned(
      [
        ...attempt('implement', 1),
        ...attempt('green', 1, {
          ...greenFailed('not ok 1'),
          outcome: { kind: 'failed', retryable: false, reason: `the run printed ${token}` },
        }),
        ...routed('implement', 2, 'green', 'failed'),
      ],
      'implement',
      2,
    );
    assert.ok(route !== undefined);
    assert.equal(route.text.includes(token), false, route.text);
    assert.match(route.text, /not ok 1/);
  });

  it('points an onBlocked route at the out doc of the attempt that blocked, with its reason', () => {
    const route = planned(
      [
        ...attempt('gauge', 1),
        ...attempt('implement', 1, {
          outcome: {
            kind: 'failed',
            retryable: false,
            reason: 'blocked (findings): The test expects the wrong slug',
          },
        }),
        ...routed('gauge', 2, 'implement', 'findings'),
      ],
      'gauge',
      2,
    );
    assert.ok(route !== undefined);
    assert.deepEqual(route.source, {
      kind: 'route',
      step: 'gauge',
      from: 'implement',
      why: 'findings',
    });
    assert.deepEqual(route.outDoc, {
      path: join('/work', 'implement-1', 'implement.md'),
      root: join('/work', 'implement-1'),
    });
    assert.match(route.text, /The test expects the wrong slug/);
  });
});

describe('routeInput', () => {
  const findings: PlannedRoute = {
    source: { kind: 'route', step: 'gauge', from: 'implement', why: 'findings' },
    text: 'Step implement was blocked: blocked (findings): The test expects the wrong slug',
    outDoc: {
      path: join('/work', 'implement-1', 'implement.md'),
      root: join('/work', 'implement-1'),
    },
  };

  it('is the route input, with the reason and then the out doc that blocked', () => {
    const doc =
      '---\n{ "status": "blocked" }\n---\nThe slug test wants `a-b`, the order says `a_b`.';
    const input = routeInput(findings, { kind: 'text', text: doc });
    assert.equal(input.name, 'route');
    assert.deepEqual(input.source, findings.source);
    assert.ok(input.text.startsWith(findings.text), input.text);
    assert.ok(input.text.includes(doc), input.text);
  });

  it('says in one line that the out doc could not be read, keeping the reason', () => {
    for (const read of [
      { kind: 'missing' },
      { kind: 'unread', reason: 'it is not a regular file' },
    ] as const) {
      const input = routeInput(findings, read);
      assert.ok(input.text.startsWith(findings.text), input.text);
      assert.match(input.text, /out doc .*could not be read/);
    }
  });

  it(`holds the text to ${MAX_ROUTE_INPUT_BYTES} bytes, keeping its start and naming the limit`, () => {
    const doc = `---\n{}\n---\n${'é'.repeat(MAX_ROUTE_INPUT_BYTES)}`;
    const { text } = routeInput(findings, { kind: 'text', text: doc });
    assert.ok(Buffer.byteLength(text, 'utf8') <= MAX_ROUTE_INPUT_BYTES, `${text.length}`);
    assert.ok(text.startsWith(findings.text));
    assert.match(text, new RegExp(`${MAX_ROUTE_INPUT_BYTES} bytes`));
    assert.equal(text.includes('�'), false);
  });

  it('is the text of a failed check as it is', () => {
    const failed: PlannedRoute = {
      source: { kind: 'route', step: 'implement', from: 'green', why: 'failed' },
      text: 'Step green failed.',
    };
    assert.deepEqual(routeInput(failed), {
      name: 'route',
      source: failed.source,
      text: 'Step green failed.',
    });
  });
});
