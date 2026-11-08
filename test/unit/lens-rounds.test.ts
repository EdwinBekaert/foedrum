// The rounds of a lens step and the dispositions of their findings (ADR 0191), when the step a
// parallel group's route went back to disposes of every child's findings (#938, ADR 0349). Pure:
// the events are folded.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fold } from '../../src/engine/fold.ts';
import { lensRounds } from '../../src/engine/lens-rounds.ts';
import type { Event } from '../../src/schemas/events.ts';

const deadlineAt = '2026-11-08T13:00:00.000Z';
const ordered: Event[] = [
  { type: 'batch.ordered', batchId: '12-1', order: { issue: 12 }, routeBy: deadlineAt },
  { type: 'batch.recipe_chosen', batchId: '12-1', recipe: 'nip', reason: 'label', source: 'label' },
];

/** One attempt of `stepId`, from schedule to its `outcome`. */
const attempt = (
  stepId: string,
  number: number,
  outcome: Extract<Event, { type: 'step.finished' }>['outcome'],
  route?: { from: string; why: 'findings' },
): Event[] => {
  const ref = { batchId: '12-1', stepId, attempt: number };
  return [
    { type: 'step.scheduled', ...ref, deadlineAt, ...(route === undefined ? {} : { route }) },
    {
      type: 'step.started',
      ...ref,
      worktree: {
        repo: 'acme/api',
        path: `/work/${stepId}-${number}`,
        branch: `foedrum/12-1/${stepId}/${number}`,
        commit: 'c'.repeat(40),
      },
    },
    { type: 'step.finished', ...ref, outcome },
  ];
};

const json = {
  file: 'src/status.ts',
  line: 40,
  severity: 'major',
  why: 'The order asks for --json',
  introduced: true,
} as const;

const tasted = (findings: readonly (typeof json)[]) => ({
  kind: 'succeeded' as const,
  output: {
    status: 'done',
    summary: 'Tasted',
    assumptions: [],
    verdict: 'changes',
    findings: [...findings],
  },
});

/** Correctness blocked and acceptance advised in one round, then the Cellarman's dispositions. */
const round = (dispositions: readonly Record<string, string | number>[]): Event[] => [
  ...attempt('implement', 1, { kind: 'succeeded', output: null }),
  ...attempt('correctness', 1, {
    kind: 'failed',
    retryable: false,
    reason: 'blocked (findings): the Taster asks for changes: No deadline',
  }),
  ...attempt('acceptance', 1, tasted([json])),
  ...attempt(
    'implement',
    2,
    {
      kind: 'succeeded',
      output: {
        status: 'done',
        summary: 'Fixed',
        assumptions: [],
        dispositions: [...dispositions],
      },
    },
    { from: 'correctness', why: 'findings' },
  ),
];

const batchOf = (events: readonly Event[]) => {
  const found = fold([...ordered, ...events]).batches.get('12-1');
  assert.ok(found !== undefined);
  return found;
};

describe("lensRounds: the dispositions of a group's every finding (#938, ADR 0349)", () => {
  const dismissedJson = {
    step: 'acceptance',
    file: 'src/status.ts',
    line: 40,
    disposition: 'dismissed',
    why: "The order's second sentence asks for --JSON",
  };
  const fixedDeadline = { file: 'src/wait.ts', line: 12, disposition: 'fixed' };

  it("gives an advisory child's round the dispositions that name its step, though another child sent the batch back", () => {
    const [acceptance] = lensRounds(batchOf(round([fixedDeadline, dismissedJson])), 'acceptance');
    assert.equal(acceptance?.attempt, 1);
    assert.deepEqual(acceptance?.dispositions, [dismissedJson]);
  });

  it('keeps on the step that sent the batch back its dispositions with no step or its own, and none of another step', () => {
    const named = { ...fixedDeadline, line: 13, step: 'correctness' };
    const events = round([fixedDeadline, dismissedJson, named]);
    const [correctness] = lensRounds(batchOf(events), 'correctness');
    assert.deepEqual(correctness?.dispositions, [fixedDeadline, named]);
  });

  it("leaves a step's round that tasted before the brewer's last attempt with its own dispositions, whatever a later route names", () => {
    const own = { file: 'src/status.ts', line: 40, disposition: 'fixed' };
    const blockedBy = (stepId: string) =>
      attempt(stepId, 1, {
        kind: 'failed',
        retryable: false,
        reason: 'blocked (findings): the Taster asks for changes',
      });
    const done = (dispositions: readonly Record<string, string | number>[]) => ({
      kind: 'succeeded' as const,
      output: {
        status: 'done',
        summary: 'Fixed',
        assumptions: [],
        dispositions: [...dispositions],
      },
    });
    const events: Event[] = [
      ...attempt('implement', 1, { kind: 'succeeded', output: null }),
      // A Taster of its own before the group, whose route the Cellarman answered.
      ...attempt('acceptance', 1, tasted([json])),
      ...attempt('implement', 2, done([own]), { from: 'acceptance', why: 'findings' }),
      ...blockedBy('correctness'),
      ...attempt(
        'implement',
        3,
        done([{ ...own, step: 'acceptance', disposition: 'dismissed', why: 'No' }]),
        {
          from: 'correctness',
          why: 'findings',
        },
      ),
    ];
    const [acceptance] = lensRounds(batchOf(events), 'acceptance');
    assert.deepEqual(acceptance?.dispositions, [own]);
  });

  it("keeps a round's dispositions when a later route of another step names none of its findings", () => {
    const events: Event[] = [
      ...round([fixedDeadline, dismissedJson]),
      ...attempt('security', 1, {
        kind: 'failed',
        retryable: false,
        reason: 'blocked (findings): the Taster asks for changes',
      }),
      // Another brewer, which never ran before, brought back by another child's route.
      ...attempt(
        'gauge',
        1,
        { kind: 'succeeded', output: { status: 'done', summary: 'Tests', assumptions: [] } },
        { from: 'security', why: 'findings' },
      ),
    ];
    const [acceptance] = lensRounds(batchOf(events), 'acceptance');
    assert.deepEqual(acceptance?.dispositions, [dismissedJson]);
  });
});
