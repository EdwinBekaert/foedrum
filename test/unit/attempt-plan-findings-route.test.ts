// The findings of the route input that a done with no commit must answer (#1181, ADR 0435): read
// from the folded events, with no plan: a retry of the routed attempt, and findings its events did
// not record (ADR 0423).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findingsRouteOf, type GroupOf } from '../../src/brewers/attempt-plan.ts';
import { fold } from '../../src/engine/fold.ts';
import type { Event } from '../../src/schemas/events.ts';

const deadlineAt = '2026-10-17T13:00:00.000Z';
const batchId = '12-1';
const brew = (attempt: number) => ({ batchId, stepId: 'brew', attempt });
const found = (file: string, line: number) => ({
  file,
  line,
  severity: 'minor' as const,
  why: 'Too bitter',
  introduced: true,
});
const blockedBy = {
  kind: 'failed',
  retryable: false,
  reason: 'blocked (findings): the Taster asks for changes: Too bitter',
} as const;

/** The round of `taste`, which blocked on `kept` and `more` findings, and sent the batch back. */
const events = (kept: number, more: number, ...retries: number[]): Event[] => [
  { type: 'batch.ordered', batchId, order: { issue: 12 }, routeBy: deadlineAt },
  { type: 'batch.recipe_chosen', batchId, recipe: 'pale', reason: 'label', source: 'label' },
  { type: 'step.scheduled', ...brew(1), deadlineAt },
  { type: 'step.started', ...brew(1) },
  { type: 'step.finished', ...brew(1), outcome: { kind: 'succeeded', output: null } },
  { type: 'step.scheduled', batchId, stepId: 'taste', attempt: 1, deadlineAt },
  { type: 'step.started', batchId, stepId: 'taste', attempt: 1 },
  {
    type: 'step.finished',
    batchId,
    stepId: 'taste',
    attempt: 1,
    outcome: blockedBy,
    findings: {
      kept: Array.from({ length: kept }, (_, at) => found('src/a.ts', at + 1)),
      more,
    },
  } as Event,
  {
    type: 'step.scheduled',
    ...brew(2),
    deadlineAt,
    route: { from: 'taste', why: 'findings' },
  },
  { type: 'step.started', ...brew(2) },
  ...retries.flatMap((attempt): Event[] => [
    {
      type: 'step.finished',
      ...brew(attempt - 1),
      outcome: { kind: 'failed', retryable: true, reason: 'claude crashed' },
    },
    { type: 'step.scheduled', ...brew(attempt), deadlineAt, retry: true },
  ]),
];

const alone: GroupOf = () => undefined;
const routeOf = (all: Event[], attempt: number, groupOf: GroupOf = alone) => {
  const batch = fold(all).batches.get(batchId);
  assert.ok(batch, 'the batch is folded');
  return findingsRouteOf(batch, brew(attempt), groupOf);
};

describe('findingsRouteOf (#1181, ADR 0435)', () => {
  it('names the route of a retry of the routed attempt, as of the attempt itself', () => {
    const expected = { from: 'taste', findings: [{ file: 'src/a.ts', line: 1 }] };
    assert.deepEqual(routeOf(events(1, 0), 2), expected);
    assert.deepEqual(routeOf(events(1, 0, 3), 3), expected);
  });

  it('names no route when its Taster’s event did not record every finding, and one when it did', () => {
    assert.equal(routeOf(events(1, 4), 2), undefined);
    assert.equal(routeOf(events(1, 4, 3), 3), undefined);
    assert.equal(routeOf(events(1, 0), 2)?.findings.length, 1);
  });

  it('names a route with no findings when its Taster’s event recorded no findings at all', () => {
    const all = events(1, 0).map((event) => {
      if (event.type !== 'step.finished' || event.stepId !== 'taste') return event;
      const { findings: _, ...rest } = event;
      return rest;
    });
    assert.deepEqual(routeOf(all, 2), { from: 'taste', findings: [] });
  });

  it('names no route when another child of the group did not record every finding', () => {
    const inGroup: GroupOf = (stepId) =>
      stepId === 'taste' || stepId === 'other' ? { group: 'tasting', lenses: [stepId] } : undefined;
    const withOther = (more: number): Event[] => {
      const all = events(1, 0);
      const at = all.findIndex((event) => event.type === 'step.scheduled' && event.attempt === 2);
      const other = { batchId, stepId: 'other', attempt: 1 };
      const round: Event[] = [
        { type: 'step.scheduled', ...other, deadlineAt },
        { type: 'step.started', ...other },
        {
          type: 'step.finished',
          ...other,
          outcome: blockedBy,
          findings: { kept: [found('src/b.ts', 2)], more },
        } as Event,
      ];
      return [...all.slice(0, at), ...round, ...all.slice(at)];
    };
    assert.deepEqual(routeOf(withOther(0), 2, inGroup), {
      from: 'taste',
      findings: [
        { file: 'src/a.ts', line: 1 },
        { step: 'other', file: 'src/b.ts', line: 2 },
      ],
    });
    assert.equal(routeOf(withOther(3), 2, inGroup), undefined);
  });
});
