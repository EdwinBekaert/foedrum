import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { lostAttemptLine } from '../../scripts/demo/walkthrough.ts';
import { formatReplay } from '../../src/cli/replay.ts';
import { formatStuck } from '../../src/cli/stuck.ts';
import { fold } from '../../src/engine/fold.ts';
import { expiredLeaseReason } from '../../src/engine/supervisor.ts';
import { Event } from '../../src/schemas/events.ts';

// The reason the supervisor records for an attempt whose lease ran out (ADR 0027), as stores hold
// it: a person reads the lines that show it in plain words, without the driver's name or a UTC time
// they would read as local (#277).
const expiredAt = '2026-10-31T14:05:04.640Z';
const recorded = (owner: string) =>
  `the attempt was lost: ${expiredLeaseReason(owner, new Date(expiredAt))}`;

/** A batch whose gauge #1 failed for `reason` and whose gauge #2 has started. */
const lostEvents = (reason: string): Event[] =>
  [
    { type: 'batch.ordered', batchId: '1-1', order: { issue: 1 }, routeBy: '2026-12-31T00:00:00Z' },
    {
      type: 'step.scheduled',
      batchId: '1-1',
      stepId: 'gauge',
      attempt: 1,
      deadlineAt: '2026-10-31T15:00:00Z',
    },
    { type: 'step.started', batchId: '1-1', stepId: 'gauge', attempt: 1 },
    {
      type: 'step.finished',
      batchId: '1-1',
      stepId: 'gauge',
      attempt: 1,
      outcome: { kind: 'failed', retryable: true, reason },
    },
    {
      type: 'step.scheduled',
      batchId: '1-1',
      stepId: 'gauge',
      attempt: 2,
      deadlineAt: '2026-10-31T16:00:00Z',
    },
    { type: 'step.started', batchId: '1-1', stepId: 'gauge', attempt: 2 },
  ].map((event) => Event.parse(event));

const replayOf = (reason: string): string => {
  const events = lostEvents(reason);
  const batch = fold(events).batches.get('1-1');
  assert.ok(batch);
  return formatReplay(
    batch,
    events.map((event, i) => ({ id: i + 1, event })),
  );
};

/** The replay's state, below its list of stored events. */
const stateOf = (replay: string): string => replay.slice(replay.indexOf('\nState\n'));

/** Replay's line for gauge's attempts. */
const gaugeLine = (reason: string): string =>
  stateOf(replayOf(reason))
    .split('\n')
    .find((line) => line.trimStart().startsWith('gauge')) ?? '';

/** Whether `text` has the recorded reason's own words: its owner's lease or the time it expired. */
const hasEngineWords = (text: string): boolean =>
  text.includes('lease of') || text.includes(expiredAt);

describe('a lost attempt in plain words', () => {
  it("replay's steps say the Cellar running a lost attempt stopped, without its owner or a UTC time", () => {
    const state = stateOf(replayOf(recorded('cellar')));
    assert.match(
      state,
      /gauge +#1 finished: failed: the attempt was lost: the Cellar running it stopped, so its lease ran out; #2 started/,
    );
    assert.ok(!hasEngineWords(state), state);
  });

  it("replay's steps say the driver running a lost attempt stopped, without its owner or a UTC time", () => {
    const state = stateOf(replayOf(recorded('ann')));
    assert.match(
      state,
      /gauge +#1 finished: failed: the attempt was lost: the driver running it stopped, so its lease ran out; #2 started/,
    );
    assert.doesNotMatch(state, /\bann\b/);
    assert.ok(!hasEngineWords(state), state);
  });

  it('foedrum stuck says why a batch whose retries a lost attempt used up is Stuck, in plain words', () => {
    const stuck: Event = Event.parse({
      type: 'batch.stuck',
      batchId: '1-1',
      reason: {
        kind: 'attempts_exhausted',
        stepId: 'gauge',
        attempts: 2,
        lastReason: recorded('cellar'),
      },
      options: ['retry', 'skip', 'cancel'],
      remindAt: '2026-11-01T10:00:00Z',
    });
    const text = formatStuck(fold([...lostEvents(recorded('cellar')), stuck]));
    assert.match(
      text,
      /attempts exhausted at gauge after 2: the attempt was lost: the Cellar running it stopped, so its lease ran out/,
    );
    assert.ok(!hasEngineWords(text), text);
  });

  it("the demo's restart line says the Cellar running the lost attempt stopped, without its owner or a UTC time", () => {
    const line = lostAttemptLine(lostEvents(recorded('cellar')).map((event) => ({ event })));
    assert.equal(
      line,
      'demo: the restart found gauge #1 lost (the Cellar running it stopped, so its lease ran out); gauge #2 brews it again',
    );
  });
});

describe('a lost attempt as recorded', () => {
  it("replay's list of stored events keeps the reason as recorded (regression test)", () => {
    assert.ok(replayOf(recorded('cellar')).includes(JSON.stringify(recorded('cellar'))));
  });

  it('an event store with the recorded reason folds to the same state as before (regression test)', () => {
    const gauge = fold(lostEvents(recorded('cellar')))
      .batches.get('1-1')
      ?.steps.get('gauge');
    const first = gauge?.attempts.get(1);
    assert.equal(first?.phase, 'finished');
    assert.deepStrictEqual(first.phase === 'finished' && first.outcome, {
      kind: 'failed',
      retryable: true,
      reason: recorded('cellar'),
    });
  });

  // Near misses of the recorded form, which replay shows as they are (regression tests).
  it('shows a lost reason without an expired lease as recorded (regression test)', () => {
    const reason = 'the attempt was lost: its lease expired';
    assert.match(
      gaugeLine(reason),
      /#1 finished: failed: the attempt was lost: its lease expired;/,
    );
  });

  it('shows an expired lease without the lost prefix as recorded (regression test)', () => {
    const reason = expiredLeaseReason('cellar', new Date(expiredAt));
    assert.ok(gaugeLine(reason).includes(`#1 finished: failed: ${reason};`));
  });

  it('shows a lost reason with more after the time as recorded (regression test)', () => {
    const reason = `${recorded('cellar')} and again`;
    assert.ok(gaugeLine(reason).includes(`#1 finished: failed: ${reason};`));
  });

  it('shows a lost reason whose time is no ISO time as recorded (regression test)', () => {
    const reason = 'the attempt was lost: the lease of cellar expired at yesterday';
    assert.ok(gaugeLine(reason).includes(`#1 finished: failed: ${reason};`));
  });
});
