// What a person does next about a batch that waits for them (ADR 0379): one `Next:` line, the same
// on every surface, each option as its whole command and what it does.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { stuckNext } from '../../src/engine/next-step.ts';
import type { StuckReason } from '../../src/schemas/events.ts';

const at = '2026-11-11T09:00:00.000Z';
const plainCommand = (text: string): string => text;
const code = (text: string): string => `\`${text}\``;

describe('stuckNext', () => {
  it('a plan waiting for its review: read it, then every option of its lane as a command', () => {
    const review: StuckReason = { kind: 'plan_review', stepId: 'plan', attempt: 1 };
    assert.equal(
      stuckNext(review, ['approve', 'lauter', 'retry', 'recipe', 'cancel'], '7', plainCommand),
      'Next: read the plan and its assumptions, then sign it off with foedrum approve 7, correct it with the Brewmaster, the brewer that plans, in a session with foedrum lauter 7, plan it again with foedrum retry 7, brew the issue with another recipe with foedrum recipe 7 <recipe> <reason>, or end it with foedrum cancel 7.',
    );
  });

  it('a question: one answer each, in order, then the other options', () => {
    const question = { q: 'Which?', options: ['a', 'b'], recommended: 'a', whyBlocking: 'Both.' };
    const asked: StuckReason = {
      kind: 'needs_input',
      stepId: 'plan',
      questions: [question, question],
    };
    assert.equal(
      stuckNext(asked, ['answer', 'retry', 'cancel'], '7', code),
      'Next: answer the questions above with `foedrum answer 7 <answer 1> <answer 2>`, try the step again with `foedrum retry 7`, or end it with `foedrum cancel 7`.',
    );
  });

  it('an issue that changed since its approval: continue or stop', () => {
    const changed: StuckReason = {
      kind: 'order_changed',
      stepId: 'plan',
      upTo: at,
      more: 0,
      changes: [{ what: 'title', at }],
    };
    assert.equal(
      stuckNext(changed, ['answer', 'cancel'], '7', code),
      'Next: answer `foedrum answer 7 continue` to brew the issue as it is now, or `foedrum answer 7 stop` to end the batch.',
    );
  });

  it('a failure: look at it, then each option, a batch that is not the latest by its id', () => {
    const passed: StuckReason = { kind: 'deadline_passed', stepId: 'plan', deadlineAt: at };
    assert.equal(
      stuckNext(passed, ['retry', 'skip', 'recipe', 'rewind', 'cancel'], '7-1', plainCommand),
      'Next: look at what failed above, then try the step again with foedrum retry 7-1, go past the step with foedrum skip 7-1, brew the issue with another recipe with foedrum recipe 7-1 <recipe> <reason>, take it back to an earlier step with foedrum rewind 7-1 <step>, or end it with foedrum cancel 7-1.',
    );
  });

  it('a step done in a person session: open it, nothing failed', () => {
    const session: StuckReason = { kind: 'waiting_for_session', stepId: 'plan' };
    assert.equal(
      stuckNext(session, ['retry', 'cancel'], '7', code),
      'Next: open its session with `foedrum brew 7 --take` in a terminal, try the step again with `foedrum retry 7`, or end it with `foedrum cancel 7`.',
    );
  });

  it('no recipe chosen: choose one, or route it again by its labels', () => {
    const routing: StuckReason = { kind: 'routing', deadlineAt: at };
    assert.equal(
      stuckNext(routing, ['retry', 'recipe', 'cancel'], '7', plainCommand),
      'Next: choose a recipe with foedrum recipe 7 <recipe> <reason>, route it again by its labels with foedrum retry 7, or end it with foedrum cancel 7.',
    );
  });

  it('a stopped batch: go on when it should, nothing failed', () => {
    const stopped: StuckReason = { kind: 'stopped', stepId: 'plan', by: 'ann', via: 'terminal' };
    assert.equal(
      stuckNext(stopped, ['retry', 'cancel'], '7', plainCommand),
      'Next: when it should go on, try the step again with foedrum retry 7, or end it with foedrum cancel 7.',
    );
  });

  it('one option alone needs no "or"', () => {
    const passed: StuckReason = { kind: 'deadline_passed', stepId: 'plan', deadlineAt: at };
    assert.equal(
      stuckNext(passed, ['cancel'], '7', plainCommand),
      'Next: look at what failed above, then end it with foedrum cancel 7.',
    );
  });
});
