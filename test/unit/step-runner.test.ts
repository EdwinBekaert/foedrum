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

  it('blocks an attempt it refuses on the environment, starting neither runner (ADR 0078)', async () => {
    const brewer = named('brewer', []);
    const check = named('check', []);
    const runner = stepRunner({
      brewer: brewer.runner,
      check: check.runner,
      isCheck: (attempt) => attempt.stepId === 'green',
      refuse: (attempt) => (attempt.stepId === 'gauge' ? 'no test report' : undefined),
    });
    const gauge = runner.start({ ref: ref('gauge'), limits: defaultLimits });
    gauge.stop();
    assert.deepEqual((await gauge.ended).ending, {
      kind: 'blocked',
      blockerKind: 'environment',
      summary: 'no test report',
    });
    assert.equal(runner.progress(ref('gauge')), undefined);
    const brew = await runner.start({ ref: ref('brew'), limits: defaultLimits }).ended;
    assert.deepEqual(brew.ending, { kind: 'succeeded', output: 'brewer' });
    assert.deepEqual([check.started, brewer.started], [[], ['brew']]);
  });

  describe('a refusal that needs a read (ADR 0297)', () => {
    /** A step runner whose refusal of `gauge` waits for `read`, and the brewer's stops. */
    const reading = (read: Promise<string | undefined>) => {
      const brewer = named('brewer', []);
      const stops: string[] = [];
      const runner = stepRunner({
        brewer: {
          ...brewer.runner,
          start: (attempt) => {
            const running = brewer.runner.start(attempt);
            return { ...running, stop: () => stops.push(attempt.ref.stepId) };
          },
        },
        check: named('check', []).runner,
        isCheck: () => false,
        refuse: (attempt) => (attempt.stepId === 'gauge' ? read : undefined),
      });
      return { brewer, runner, stops };
    };

    it('blocks the attempt on the environment with what the read found, starting no runner', async () => {
      const { brewer, runner } = reading(Promise.resolve('no test map'));
      const ended = await runner.start({ ref: ref('gauge'), limits: defaultLimits }).ended;
      assert.deepEqual(ended.ending, {
        kind: 'blocked',
        blockerKind: 'environment',
        summary: 'no test map',
      });
      assert.deepEqual(brewer.started, []);
    });

    it('starts the attempt once the read finds nothing to refuse', async () => {
      const { brewer, runner } = reading(Promise.resolve(undefined));
      const ended = await runner.start({ ref: ref('gauge'), limits: defaultLimits }).ended;
      assert.deepEqual(ended.ending, { kind: 'succeeded', output: 'brewer' });
      assert.deepEqual(brewer.started, ['gauge']);
    });

    it('cancels an attempt stopped while the read runs, and starts no runner', async () => {
      let answer: (why: string | undefined) => void = () => {};
      const { brewer, runner } = reading(new Promise((resolve) => (answer = resolve)));
      const gauge = runner.start({ ref: ref('gauge'), limits: defaultLimits });
      gauge.stop();
      answer(undefined);
      assert.deepEqual((await gauge.ended).ending, { kind: 'cancelled' });
      assert.deepEqual(brewer.started, []);
    });

    it('cancels an attempt stopped while the read runs, though the read then fails', async () => {
      let fail: (error: Error) => void = () => {};
      const { brewer, runner } = reading(new Promise((_, reject) => (fail = reject)));
      const gauge = runner.start({ ref: ref('gauge'), limits: defaultLimits });
      gauge.stop();
      fail(new Error('git was stopped'));
      assert.deepEqual((await gauge.ended).ending, { kind: 'cancelled' });
      assert.deepEqual(brewer.started, []);
    });

    it('stops the runner it started after the read', async () => {
      const { brewer, runner, stops } = reading(Promise.resolve(undefined));
      const gauge = runner.start({ ref: ref('gauge'), limits: defaultLimits });
      await gauge.ended;
      gauge.stop();
      assert.deepEqual([brewer.started, stops], [['gauge'], ['gauge']]);
    });

    it('blocks the attempt on the environment when the read fails', async () => {
      const { brewer, runner } = reading(Promise.reject(new Error('git crashed')));
      const ended = await runner.start({ ref: ref('gauge'), limits: defaultLimits }).ended;
      assert.deepEqual(ended.ending, {
        kind: 'blocked',
        blockerKind: 'environment',
        summary: 'whether gauge may run cannot be read: git crashed',
      });
      assert.deepEqual(brewer.started, []);
    });
  });

  it('reports the progress of whichever runner runs the attempt', () => {
    const { runner } = setup();
    assert.equal(runner.progress(ref('green'))?.turnsWithoutProgress, 5);
    assert.equal(runner.progress(ref('brew'))?.turnsWithoutProgress, 6);
    assert.equal(runner.progress(ref('taste')), undefined);
  });
});
