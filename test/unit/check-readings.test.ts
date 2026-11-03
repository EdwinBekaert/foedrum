// The checks input (ADR 0308): which steps' readings a brewer's attempt reads, folded from plain
// events. The planner's tests show the input in a prompt; these pin the edges of what it holds.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { baseMergeKey } from '../../src/engine/base-merge.ts';
import { checksInput } from '../../src/engine/check-readings.ts';
import { effectKey } from '../../src/engine/effect-key.ts';
import { fold } from '../../src/engine/fold.ts';
import type { Event, GravityReading } from '../../src/schemas/events.ts';

const deadlineAt = '2026-10-17T13:00:00.000Z';
const head = 'c'.repeat(40);
const passed: GravityReading = {
  result: 'exited',
  check: 'test',
  command: 'npm test',
  exitCode: 0,
  tail: '',
};
const failed: GravityReading = {
  ...passed,
  exitCode: 1,
  failing: { tests: ['prints --json'], more: 0 },
};
const setup: GravityReading = {
  result: 'exited',
  setup: true,
  command: 'npm ci',
  exitCode: 0,
  tail: '',
};

const ordered: Event = {
  type: 'batch.ordered',
  batchId: '12-1',
  order: { issue: 12 },
  routeBy: deadlineAt,
};

/** Attempt `attempt` of `stepId`, started at `commit` (none: no worktree), with `readings`. */
const run = (
  stepId: string,
  attempt: number,
  commit: string | undefined,
  readings: GravityReading[],
): Event[] => {
  const ref = { batchId: '12-1', stepId, attempt };
  const worktree =
    commit === undefined
      ? {}
      : {
          worktree: {
            repo: 'acme/api',
            path: join('/work', `${stepId}-${attempt}`),
            branch: `foedrum/12-1/${stepId}/${attempt}`,
            commit,
          },
        };
  return [
    { type: 'step.scheduled', ...ref, deadlineAt },
    { type: 'step.started', ...ref, ...worktree },
    { type: 'step.finished', ...ref, outcome: { kind: 'succeeded', output: null }, readings },
  ];
};

const inputOf = (events: Event[], commit: string | undefined) => {
  const state = fold([ordered, ...events]);
  const batch = state.batches.get('12-1');
  assert.ok(batch);
  return checksInput(state, batch, commit);
};

describe('checksInput (ADR 0308)', () => {
  it('gives an attempt with no commit of its own no checks, beside a step with no worktree (regression test)', () => {
    const events = run('green', 1, undefined, [passed]);
    assert.equal(inputOf(events, undefined), undefined);
    // The same readings on a commit are read: the guard, not the readings, leaves them out.
    assert.match(inputOf(run('green', 1, head, [passed]), head)?.text ?? '', /passed/);
  });

  it('reads only the latest attempt of a step that ran twice on the same commit (regression test)', () => {
    const events = [...run('green', 1, head, [failed]), ...run('green', 2, head, [passed])];
    const text = inputOf(events, head)?.text ?? '';
    assert.match(text, /^- Step green:\n {2}- the check "test" \(npm test\) passed$/);
    assert.doesNotMatch(text, /prints --json/);
  });

  it('leaves out a step whose only readings on the commit are its setup (regression test)', () => {
    assert.equal(inputOf(run('green', 1, head, [setup]), head), undefined);
  });

  it('lists the steps in the order they first ran, each with its own checks (regression test)', () => {
    const lint: GravityReading = { ...passed, check: 'lint', command: 'npm run lint' };
    const events = [...run('green', 1, head, [passed]), ...run('build', 1, head, [lint])];
    assert.equal(
      inputOf(events, head)?.text,
      [
        '- Step green:',
        '  - the check "test" (npm test) passed',
        '- Step build:',
        '  - the check "lint" (npm run lint) passed',
      ].join('\n'),
    );
  });

  it("reads the base merge of a step's latest attempt, not of an earlier one (regression test)", () => {
    /** The merge of the base attempt `attempt` of green made at its start, as `merged`. */
    const merge = (attempt: number, merged: string): Event => ({
      type: 'effect.applied',
      key: effectKey.encode(baseMergeKey({ batchId: '12-1', stepId: 'green', attempt })),
      result: { base: 'a'.repeat(40), merged },
    });
    const [first, second] = ['d'.repeat(40), 'e'.repeat(40)];
    const events = [
      ...run('green', 1, 'b'.repeat(40), [failed]),
      merge(1, first),
      ...run('green', 2, 'f'.repeat(40), [passed]),
      merge(2, second),
    ];
    assert.match(inputOf(events, second)?.text ?? '', /passed/);
    assert.equal(inputOf(events, first), undefined);
  });
});
