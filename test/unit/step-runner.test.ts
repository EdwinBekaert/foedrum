// The step runner (ADR 0069): a check step's attempts run on the check runner, every other
// attempt on the brewer runner.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AttemptRef } from '../../src/engine/attempt-key.ts';
import type { AttemptEnd, BrewerRunner } from '../../src/engine/brewer-runner.ts';
import { stepRunner } from '../../src/engine/step-runner.ts';
import { defaultLimits } from '../helpers/brewing.ts';

/** A runner that ends each attempt as `ending` says, and knows the progress of `runs`. */
const named = (name: string, runs: readonly string[]) => {
  const started: string[] = [];
  const runner: BrewerRunner = {
    start: ({ ref }) => {
      started.push(ref.stepId);
      const end: AttemptEnd = { ending: { kind: 'succeeded', output: name } };
      return { ended: Promise.resolve(end), stop: () => {} };
    },
    progress: (ref) =>
      runs.includes(ref.stepId)
        ? { lastProgressAt: new Date(0), turnsWithoutProgress: name.length }
        : undefined,
  };
  return { started, runner };
};

const ref = (stepId: string): AttemptRef => ({ batchId: '12-1', stepId, attempt: 1 });

describe('stepRunner', () => {
  const setup = () => {
    const brewer = named('brewer', ['brew']);
    const check = named('check', ['green']);
    const runner = stepRunner({
      brewer: brewer.runner,
      check: check.runner,
      isCheck: (attempt) => attempt.stepId === 'green',
    });
    return { brewer, check, runner };
  };

  it("starts a check step's attempt on the check runner, any other on the brewer runner", async () => {
    const { brewer, check, runner } = setup();
    const green = await runner.start({ ref: ref('green'), limits: defaultLimits }).ended;
    const brew = await runner.start({ ref: ref('brew'), limits: defaultLimits }).ended;
    assert.deepEqual(
      [green.ending, brew.ending],
      [
        { kind: 'succeeded', output: 'check' },
        { kind: 'succeeded', output: 'brewer' },
      ],
    );
    assert.deepEqual([check.started, brewer.started], [['green'], ['brew']]);
  });

  it('reports the progress of whichever runner runs the attempt', () => {
    const { runner } = setup();
    assert.equal(runner.progress(ref('green'))?.turnsWithoutProgress, 5);
    assert.equal(runner.progress(ref('brew'))?.turnsWithoutProgress, 6);
    assert.equal(runner.progress(ref('taste')), undefined);
  });
});
