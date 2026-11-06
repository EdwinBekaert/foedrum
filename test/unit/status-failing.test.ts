// A person sees a batch that keeps failing (ADR 0335): `foedrum status`, `foedrum stuck` and the
// status comment show the mark, and a batch whose own rendering throws stops none of the others.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { describeLane, formatOrderStatus, formatStatus } from '../../src/cli/status.ts';
import { formatStuck } from '../../src/cli/stuck.ts';
import { type Batch, emptyState, type Failing, type State } from '../../src/engine/fold.ts';
import { renderStatus } from '../../src/engine/status-comment.ts';

const remindAt = '2026-11-08T12:00:00.000Z';
const failing: Failing = {
  pass: 'effects',
  summary: 'the plan could not be read',
  since: '2026-11-06T11:00:00.000Z',
};
const batch = (id: string, issue: number, fields: Partial<Batch> = {}): Batch => ({
  id,
  issue,
  lane: { kind: 'on_tap', pullRequests: [] },
  steps: new Map(),
  rewinds: [],
  ...fields,
});
const stateOf = (...batches: readonly Batch[]): State => ({
  ...emptyState,
  batches: new Map(batches.map((one) => [one.id, one])),
});
const stuckFailing = (id: string, issue: number): Batch =>
  batch(id, issue, {
    failing,
    lane: {
      kind: 'stuck',
      reason: { kind: 'failing', stepId: 'plan', ...failing },
      options: ['retry', 'skip', 'recipe', 'rewind', 'cancel'],
      remindAt,
    },
  });
/** A batch whose rendering throws: a lane no reader knows. */
const unreadable = (id: string, issue: number, fields: Partial<Batch> = {}): Batch =>
  batch(id, issue, { lane: { kind: 'unknown' } as unknown as Batch['lane'], ...fields });
const stuckUnreadable = (id: string, issue: number): Batch =>
  batch(id, issue, {
    lane: {
      kind: 'stuck',
      reason: { kind: 'unknown' } as never,
      options: ['cancel'],
      remindAt,
    },
  });

describe('foedrum status', () => {
  it("shows a marked batch's pass, since when and summary", () => {
    const text = formatStatus(stateOf(batch('1-1', 1, { failing })));
    assert.match(
      text,
      /failing in effects since 2026-11-06T11:00:00\.000Z: the plan could not be read/,
    );
  });

  it('adds it to the row of the lane it stays in, and nothing to a batch with no mark', () => {
    assert.match(formatStatus(stateOf(batch('1-1', 1, { failing }))), /on tap +failing in effects/);
    assert.doesNotMatch(formatStatus(stateOf(batch('1-1', 1))), /failing/);
  });

  it('shows a marked batch whose rendering throws, with its mark', () => {
    const text = formatStatus(stateOf(unreadable('1-1', 1, { failing })));
    assert.match(text, /1-1/);
    assert.match(text, /cannot be read/);
    assert.match(text, /failing in effects since 2026-11-06T11:00:00\.000Z/);
  });

  it('does not fail for the other batches when one batch’s rendering throws', () => {
    const text = formatStatus(stateOf(batch('1-1', 1), unreadable('2-1', 2), batch('3-1', 3)));
    assert.match(text, /3 batches/);
    assert.match(text, /1-1/);
    assert.match(text, /2-1/);
    assert.match(text, /3-1/);
  });

  it('names the batch and the error in the row that cannot be read', () => {
    assert.match(formatStatus(stateOf(unreadable('2-1', 2))), /2-1.*cannot be read: .*unknown/);
  });

  it('shows a batch whose rendering throws in the board of its order too', () => {
    const broken = unreadable('2-1', 2);
    assert.match(formatOrderStatus(stateOf(broken), [broken], new Map()), /cannot be read/);
  });

  it('says what a batch Stuck on failing failed on, once', () => {
    const text = formatStatus(stateOf(stuckFailing('1-1', 1)));
    assert.equal(text.match(/the plan could not be read/g)?.length, 1);
  });

  it('describes the lane of a batch Stuck on failing', () => {
    assert.deepStrictEqual(describeLane(stuckFailing('1-1', 1), '1'), {
      lane: 'stuck',
      detail: `failing at plan in effects since 2026-11-06T11:00:00.000Z: the plan could not be read; reminder ${remindAt}`,
    });
  });
});

describe('a batch whose rendering throws', () => {
  it('still shows the mark of a batch Stuck on failing, whose reason would have said it', () => {
    // Its lane reads, and the pause read after it throws.
    const broken: State = { ...stateOf(stuckFailing('1-1', 1)), pauses: null as never };
    const text = formatStatus(broken);
    assert.match(text, /cannot be read/);
    assert.match(text, /failing in effects since 2026-11-06T11:00:00\.000Z/);
  });

  it('shows the lane and the mark in foedrum stuck', () => {
    const broken = { ...stuckUnreadable('1-1', 1), failing };
    const text = formatStuck(stateOf(broken));
    assert.match(text, /1-1.*stuck.*cannot be read.*failing in effects since/);
  });

  it('keeps the message on its line, so what it quotes cannot forge a row', () => {
    const reason = { kind: `x${String.fromCodePoint(0x2028)}9-1 forged` } as never;
    const lane: Batch['lane'] = { kind: 'stuck', reason, options: ['cancel'], remindAt };
    const text = formatStatus(stateOf(batch('2-1', 2, { lane })));
    assert.match(text, /cannot be read/);
    assert.doesNotMatch(text, /forged/);
  });
});

describe('foedrum stuck', () => {
  it('shows the mark of a batch Stuck for another reason', () => {
    const stopped = batch('1-1', 1, {
      failing,
      lane: {
        kind: 'stuck',
        reason: { kind: 'stopped', stepId: 'plan', by: 'ada', via: 'terminal' },
        options: ['retry', 'cancel'],
        remindAt,
      },
    });
    assert.match(formatStuck(stateOf(stopped)), /1-1.*stopped.*failing in effects since/);
  });

  it('lists a marked batch that is not Stuck beside one that is', () => {
    const text = formatStuck(stateOf(stuckFailing('1-1', 1), batch('2-1', 2, { failing })));
    assert.match(text, /1 Stuck batch/);
    assert.match(text, /2-1 on_tap: failing in effects/);
  });

  it('lists the others when the open findings of one cannot be rendered (regression test)', () => {
    const broken = batch('1-1', 1, {
      lane: {
        kind: 'stuck',
        reason: {
          kind: 'blocked',
          stepId: 'plan',
          blockerKind: 'findings',
          summary: 'open',
          roundsOut: { rounds: 2, open: null, more: 0 } as never,
        },
        options: ['cancel'],
        remindAt,
      },
    });
    const text = formatStuck(stateOf(broken, stuckFailing('2-1', 2)));
    assert.match(text, /options: cancel/);
    assert.match(text, /2-1.*failing at plan/);
  });

  it('lists a batch Stuck on failing with its options', () => {
    const text = formatStuck(stateOf(stuckFailing('1-1', 1)));
    assert.match(text, /1 Stuck batch/);
    assert.match(text, /failing at plan in effects/);
    assert.match(text, /options: retry, skip, recipe, rewind, cancel/);
  });

  it('lists a marked batch that is not Stuck apart, so an on-tap mark shows here too', () => {
    const text = formatStuck(stateOf(batch('1-1', 1, { failing })));
    assert.match(text, /No Stuck batches\./);
    assert.match(text, /1-1.*failing in effects since 2026-11-06T11:00:00\.000Z/);
  });

  it('prints only the line it always did with no Stuck batch and no mark, while a mark adds its own', () => {
    const bare = `${formatStuck(stateOf(batch('1-1', 1)))}`;
    assert.equal(bare.trimEnd(), 'No Stuck batches.');
    assert.equal(bare.split('\n').length, 2);
    assert.notEqual(formatStuck(stateOf(batch('1-1', 1, { failing }))), bare);
  });

  it('shows a Stuck batch whose rendering throws, and the others', () => {
    const text = formatStuck(stateOf(stuckUnreadable('1-1', 1), stuckFailing('2-1', 2)));
    assert.match(text, /2 Stuck batches/);
    assert.match(text, /1-1.*cannot be read/);
    assert.match(text, /options: cancel/);
    assert.match(text, /2-1.*failing at plan/);
  });
});

describe('the status comment', () => {
  it('shows the mark of a batch on tap, not blaming it', () => {
    const text = renderStatus(batch('1-1', 1, { failing }));
    assert.match(text, /On tap/);
    assert.match(
      text,
      /\*\*Failing\*\*: the effects pass has failed since 2026-11-06T11:00:00\.000Z: the plan could not be read/,
    );
  });

  it('shows no such line with no mark, and shows one with it', () => {
    assert.doesNotMatch(renderStatus(batch('1-1', 1)), /Failing/);
    assert.match(renderStatus(batch('1-1', 1, { failing })), /Failing/);
  });

  it('leaves out a summary that reads like a secret, on the mark and on the Stuck', () => {
    const token = `ghp_${'a'.repeat(36)}`;
    const secret = { ...failing, summary: token };
    assert.doesNotMatch(renderStatus(batch('1-1', 1, { failing: secret })), /ghp_/);
    const stuck = stuckFailing('1-1', 1);
    const reason = { kind: 'failing', stepId: 'plan', ...secret } as const;
    const lane = { ...stuck.lane, reason } as Batch['lane'];
    assert.doesNotMatch(renderStatus({ ...stuck, lane }), /ghp_/);
  });

  it('shows why a batch is Stuck on failing, with no second line for its mark', () => {
    const text = renderStatus(stuckFailing('1-1', 1));
    assert.match(
      text,
      /\*\*Stuck\*\*: `plan` could not go on: the effects pass has failed since 2026-11-06T11:00:00\.000Z: the plan could not be read/,
    );
    assert.doesNotMatch(text, /\*\*Failing\*\*/);
  });

  it('shows a summary as plain text: what it quotes cannot render', () => {
    const quoting = { ...failing, summary: '![x](https://evil.example/a.png) @someone' };
    const text = renderStatus(batch('1-1', 1, { failing: quoting }));
    assert.match(text, /Failing/);
    assert.doesNotMatch(text, /!\[x\]\(https/);
  });
});
