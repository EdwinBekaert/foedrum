// The status comment's line on the tests a Gauger named (ADR 0342): the latest run whose reports
// were read decides it, a run of the same batch only. Rendered from folded events (ADR 0021).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Batch } from '../../src/engine/fold.ts';
import { fold } from '../../src/engine/fold.ts';
import { renderStatus } from '../../src/engine/status-comment.ts';
import type { Event, UnreportedTests } from '../../src/schemas/events.ts';

const deadlineAt = '2026-11-06T12:30:00.000Z';
const missing: UnreportedTests = { tests: ['adds through the real tool'], more: 0 };
const allHeld: UnreportedTests = { tests: [], more: 0 };
const LINE = 'Not proven: the test run reports no test named: adds through the real tool';

const ordered = (batchId: string): Event[] => [
  { type: 'batch.ordered', batchId, order: { issue: 7 }, routeBy: deadlineAt },
  { type: 'batch.recipe_chosen', batchId, recipe: 'nip', reason: 'l', source: 'label' },
];

/** One attempt of a step, from its schedule to its end; `unreported` as its run read. */
const attempt = (
  stepId: string,
  number: number,
  unreported?: UnreportedTests,
  batchId = '7-1',
): Event[] => {
  const ref = { batchId, stepId, attempt: number };
  return [
    { type: 'step.scheduled', ...ref, deadlineAt },
    { type: 'step.started', ...ref },
    {
      type: 'step.finished',
      ...ref,
      outcome: { kind: 'succeeded', output: null },
      ...(unreported === undefined ? {} : { unreported }),
    },
  ];
};

const batchOf = (events: Event[], batchId = '7-1'): Batch => {
  const batch = fold(events).batches.get(batchId);
  assert.ok(batch !== undefined);
  return batch;
};
const render = (events: Event[], batchId = '7-1'): string =>
  renderStatus(batchOf(events, batchId), ['red', 'green']);

describe('renderStatus: the tests a Gauger named (ADR 0342)', () => {
  it('a red proof that names one and a green check that reports it: the line goes', () => {
    const red = [...ordered('7-1'), ...attempt('red', 1, missing)];
    assert.ok(render(red).includes(LINE), render(red));
    const green = [...red, ...attempt('green', 1, allHeld)];
    assert.ok(!render(green).includes('Not proven'), render(green));
  });

  it('a red proof that reports them and a green check that does not: the line comes', () => {
    const red = [...ordered('7-1'), ...attempt('red', 1, allHeld)];
    assert.ok(!render(red).includes('Not proven'), render(red));
    const green = [...red, ...attempt('green', 1, missing)];
    assert.ok(render(green).includes(LINE), render(green));
  });

  it('a retry of the step whose run reports them takes the line off', () => {
    const first = [...ordered('7-1'), ...attempt('green', 1, missing)];
    assert.ok(render(first).includes(LINE), render(first));
    const retry = [...first, ...attempt('green', 2, allHeld)];
    assert.ok(!render(retry).includes('Not proven'), render(retry));
  });

  it('a retry of the step whose run does not report them brings the line', () => {
    const first = [...ordered('7-1'), ...attempt('green', 1, allHeld)];
    assert.ok(!render(first).includes('Not proven'), render(first));
    const retry = [...first, ...attempt('green', 2, missing)];
    assert.ok(render(retry).includes(LINE), render(retry));
  });

  it('a run whose reports were not read leaves the line of the run before it', () => {
    const events = [...ordered('7-1'), ...attempt('red', 1, missing), ...attempt('green', 1)];
    assert.ok(render(events).includes(LINE), render(events));
  });

  it('a later batch of the order starts clean', () => {
    const events = [
      ...ordered('7-1'),
      ...attempt('red', 1, missing),
      ...ordered('7-2'),
      ...attempt('red', 1, undefined, '7-2'),
    ];
    assert.ok(render(events).includes(LINE), render(events));
    assert.ok(!render(events, '7-2').includes('Not proven'), render(events, '7-2'));
  });

  it('says how many more it leaves out', () => {
    const events = [
      ...ordered('7-1'),
      ...attempt('red', 1, { tests: ['adds', 'subtracts'], more: 3 }),
    ];
    assert.ok(
      render(events).includes(
        'Not proven: the test run reports no test named: adds, subtracts and 3 more',
      ),
      render(events),
    );
  });

  it("tells a name as a finding's text is told: no secret, one line, no Markdown, no mention", () => {
    const token = ['ghp', 'A1b2'.repeat(9)].join('_');
    const events = [
      ...ordered('7-1'),
      ...attempt('red', 1, {
        tests: [`logs in with ${token}`, 'adds\n**forged** @someone line'],
        more: 0,
      }),
    ];
    const text = render(events);
    assert.doesNotMatch(text, /ghp|A1b2/);
    const [line] = text.split('\n').filter((each) => each.includes('Not proven:'));
    assert.ok(line?.endsWith('adds \\*\\*forged\\*\\* &#64;someone line'), line);
    assert.ok(!text.includes('\n**forged'), text);
  });
});
