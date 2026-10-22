import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type AttemptFacts,
  type AttemptLimits,
  type CommitsSeen,
  noteDenial,
  settleAttempt,
} from '../../src/engine/brewer-runner.ts';
import { OutDocFrontmatter, outDocFrontmatter } from '../../src/schemas/out-doc.ts';
import { z } from '../../src/schemas/zod.ts';
import { documentedSpendLimits, documentedUsageLimits } from '../fixtures/claude-usage-limits.ts';
import { outDoc } from '../helpers/fake-brewer-runner.ts';

const limits: AttemptLimits = {
  outDoc: { file: 'plan.md', schema: OutDocFrontmatter },
  maxTurns: 100,
  maxDenials: 5,
};
const done = outDoc({ status: 'done', summary: 'Planned' });
const facts = (more: Partial<AttemptFacts> = {}): AttemptFacts => ({
  exit: { kind: 'exited', code: 0 },
  outDoc: done,
  denials: 0,
  deniedTools: [],
  turns: 10,
  ...more,
});
const succeeded = {
  kind: 'succeeded',
  output: { status: 'done', summary: 'Planned', assumptions: [] },
};

describe('noteDenial', () => {
  it('counts every denial and keeps each tool once, in the order first denied', () => {
    const tools = ['WebFetch', 'Bash(npm test)', 'WebFetch', 'Edit', 'Bash(npm test)'];
    const seen = tools.reduce(noteDenial, { denials: 0, deniedTools: [] });
    assert.deepStrictEqual(seen, {
      denials: 5,
      deniedTools: ['WebFetch', 'Bash(npm test)', 'Edit'],
    });
  });

  it('changes none of what it was given', () => {
    const before = { denials: 1, deniedTools: ['WebFetch'] };
    noteDenial(before, 'Edit');
    assert.deepStrictEqual(before, { denials: 1, deniedTools: ['WebFetch'] });
  });
});

describe('settleAttempt', () => {
  it('succeeds at its limits, not past them', () => {
    assert.deepStrictEqual(settleAttempt(facts({ turns: 100, denials: 4 }), limits), succeeded);
  });

  it('counts a crash as a failure even after a valid out doc', () => {
    assert.deepStrictEqual(settleAttempt(facts({ exit: { kind: 'exited', code: 3 } }), limits), {
      kind: 'failed',
      retryable: true,
      reason: 'the brewer process exited with code 3',
    });
  });

  it('puts a process that never started before every limit', () => {
    const unstartable = { kind: 'unstartable', reason: 'claude was not found' } as const;
    const ending = settleAttempt(
      facts({ exit: unstartable, outDoc: undefined, denials: 9, turns: 101 }),
      limits,
    );
    assert.deepStrictEqual(ending, {
      kind: 'failed',
      retryable: false,
      reason: 'the brewer could not start: claude was not found',
    });
  });

  // ADR 0046: the session claude set up is not the one asked for (dropped settings, a user's
  // settings); another attempt would meet the same environment, so it is Stuck at once.
  it('blocks on the environment when the session is not what the runner asked for, before anything else', () => {
    const ending = settleAttempt(
      facts({
        environment: 'permission mode "default", not dontAsk',
        exit: { kind: 'unstartable', reason: 'claude was not found' },
        denials: 9,
        turns: 101,
      }),
      limits,
    );
    assert.deepStrictEqual(ending, {
      kind: 'blocked',
      blockerKind: 'environment',
      summary:
        'claude did not set up the session the runner asked for: permission mode "default", not dontAsk',
    });
  });

  // ADR 0091: claude refuses every request until the window resets, so another attempt now would
  // be refused too. A human retries after the reset claude named.
  it('blocks on the environment when a usage window ran out, naming the limit and its reset', () => {
    for (const { limit, resets } of documentedUsageLimits) {
      const ending = settleAttempt(
        facts({
          usageLimit: { limit, resets },
          exit: { kind: 'exited', code: 1 },
          streamError: 'api_error: rejected',
          outDoc: undefined,
          denials: 9,
          turns: 101,
        }),
        limits,
      );
      assert.deepStrictEqual(ending, {
        kind: 'blocked',
        blockerKind: 'environment',
        summary: `claude hit its ${limit} limit, which resets ${resets}: retry the step after that`,
      });
    }
  });

  // Review of #252: however the process ended after the refusal, the window is what to wait for.
  it('puts a usage limit before a process that could not start, was killed, overflowed or stopped', () => {
    const exits = [
      { kind: 'unstartable', reason: 'claude was not found' },
      { kind: 'killed', signal: 'SIGTERM' },
      { kind: 'overflowed', what: 'a stream line passed 8388608 bytes' },
      { kind: 'stopped' },
    ] as const;
    for (const exit of exits) {
      const ending = settleAttempt(
        facts({ exit, usageLimit: { limit: 'Opus', resets: '3:45pm' }, outDoc: undefined }),
        limits,
      );
      assert.deepStrictEqual(ending, {
        kind: 'blocked',
        blockerKind: 'environment',
        summary: 'claude hit its Opus limit, which resets 3:45pm: retry the step after that',
      });
    }
  });

  // #257, ADR 0129: no request goes through until a human raises the limit or adds credits, and
  // no reset comes by itself, so another attempt now would be refused too.
  it('blocks on the environment when a spend limit or the credit balance refused it', () => {
    const summaryOf = (spendLimit: (typeof documentedSpendLimits)[number]['spendLimit']) =>
      spendLimit.kind === 'credit'
        ? "claude's credit balance is too low: no request goes through until credits are added, then retry the step"
        : `claude hit its ${spendLimit.limit}: no request goes through until the limit is raised, then retry the step`;
    const exits = [
      { kind: 'exited', code: 1 },
      { kind: 'unstartable', reason: 'claude was not found' },
      { kind: 'killed', signal: 'SIGTERM' },
      { kind: 'overflowed', what: 'a stream line passed 8388608 bytes' },
      { kind: 'stopped' },
    ] as const;
    for (const { spendLimit } of documentedSpendLimits) {
      const summary = summaryOf(spendLimit);
      for (const exit of exits) {
        const ending = settleAttempt(
          facts({
            spendLimit,
            exit,
            streamError: 'api_error: rejected',
            outDoc: undefined,
            denials: 9,
            turns: 101,
          }),
          limits,
        );
        assert.deepStrictEqual(ending, { kind: 'blocked', blockerKind: 'environment', summary });
      }
    }
  });

  // ADR 0117: the next attempt starts fresh, which a block on the environment would not let it.
  it('fails retryably when claude could not resume the session, before the error its result reported', () => {
    const said = 'No conversation found with session ID: 0f8fad5b-d9cb-469f-a165-708677289500';
    const ending = settleAttempt(
      facts({
        unresumed: said,
        exit: { kind: 'exited', code: 1 },
        outDoc: undefined,
        streamError: 'error_during_execution: No conversation found',
        turns: 0,
      }),
      limits,
    );
    assert.deepStrictEqual(ending, {
      kind: 'failed',
      retryable: true,
      reason: `claude could not resume the session: ${said}`,
    });
  });

  // A limit the result names lasts whatever session ran: a fresh attempt would meet it too.
  it('puts a usage or spend limit before a session claude could not resume (review of #371)', () => {
    const unresumed = 'You have hit your limit';
    const usageLimit = { limit: 'session', resets: '3:45pm' } as const;
    assert.deepStrictEqual(settleAttempt(facts({ unresumed, usageLimit }), limits), {
      kind: 'blocked',
      blockerKind: 'environment',
      summary: 'claude hit its session limit, which resets 3:45pm: retry the step after that',
    });
    const spendLimit = { kind: 'credit' } as const;
    const ending = settleAttempt(facts({ unresumed, spendLimit }), limits);
    assert.equal(ending.kind === 'blocked' && ending.blockerKind, 'environment');
  });

  it('puts a session that is not what was asked, and a usage limit, before a spend limit', () => {
    const spendLimit = { kind: 'credit' } as const;
    assert.deepStrictEqual(settleAttempt(facts({ environment: 'no init', spendLimit }), limits), {
      kind: 'blocked',
      blockerKind: 'environment',
      summary: 'claude did not set up the session the runner asked for: no init',
    });
    const usageLimit = { limit: 'session', resets: '3:45pm' } as const;
    assert.deepStrictEqual(settleAttempt(facts({ usageLimit, spendLimit }), limits), {
      kind: 'blocked',
      blockerKind: 'environment',
      summary: 'claude hit its session limit, which resets 3:45pm: retry the step after that',
    });
  });

  it('puts a session that is not what was asked before a usage limit', () => {
    const ending = settleAttempt(
      facts({ environment: 'no init', usageLimit: { limit: 'weekly', resets: 'Mon 12:00am' } }),
      limits,
    );
    assert.deepStrictEqual(ending, {
      kind: 'blocked',
      blockerKind: 'environment',
      summary: 'claude did not set up the session the runner asked for: no init',
    });
  });

  it('puts a crash before garbage in the stream', () => {
    const killed = { kind: 'killed', signal: 'SIGSEGV' } as const;
    assert.deepStrictEqual(settleAttempt(facts({ exit: killed, garbage: 'x' }), limits), {
      kind: 'failed',
      retryable: true,
      reason: 'the brewer process was killed by SIGSEGV',
    });
  });

  // ADR 0042: is_error decides, not the subtype or the exit code; an API error ends as success.
  it('fails, retryably, when claude reported an error, even after a clean exit and a valid out doc', () => {
    for (const exit of [
      { kind: 'exited', code: 0 },
      { kind: 'exited', code: 1 },
    ] as const) {
      assert.deepStrictEqual(
        settleAttempt(facts({ exit, streamError: 'api_error: Overloaded' }), limits),
        {
          kind: 'failed',
          retryable: true,
          reason: 'claude reported an error: api_error: Overloaded',
        },
      );
    }
  });

  it('puts a crash before an error claude reported, and the error before garbage', () => {
    const killed = { kind: 'killed', signal: 'SIGSEGV' } as const;
    const crashed = settleAttempt(facts({ exit: killed, streamError: 'api_error' }), limits);
    assert.equal(
      crashed.kind === 'failed' && crashed.reason,
      'the brewer process was killed by SIGSEGV',
    );
    const both = settleAttempt(facts({ streamError: 'api_error', garbage: 'x' }), limits);
    assert.equal(both.kind === 'failed' && both.reason, 'claude reported an error: api_error');
  });

  // ADR 0028: the runner caps the out doc it reads, so an oversized one never reaches the log.
  it('fails, retryably, with the reason when the runner did not read the out doc', () => {
    const ending = settleAttempt(
      facts({ outDoc: undefined, outDocUnread: 'it is larger than 1 MiB' }),
      limits,
    );
    assert.deepStrictEqual(ending, {
      kind: 'failed',
      retryable: true,
      reason: 'the out doc plan.md was not read: it is larger than 1 MiB',
    });
  });

  // A line or stderr past the runner's limit (ADR 0046): another attempt may read less.
  it('fails, retryably, when the output passed a limit of the runner', () => {
    const exit = { kind: 'overflowed', what: 'a stream line passed 8 MiB' } as const;
    assert.deepStrictEqual(settleAttempt(facts({ exit }), limits), {
      kind: 'failed',
      retryable: true,
      reason: "the brewer's output passed a limit: a stream line passed 8 MiB",
    });
  });

  it('cancels an attempt the engine stopped within its limits', () => {
    assert.deepStrictEqual(settleAttempt(facts({ exit: { kind: 'stopped' } }), limits), {
      kind: 'cancelled',
    });
  });

  it('puts the denials before the budget: the environment is what to fix', () => {
    const ending = settleAttempt(
      facts({ exit: { kind: 'stopped' }, denials: 9, deniedTools: ['WebFetch'], turns: 101 }),
      limits,
    );
    assert.deepStrictEqual(ending, {
      kind: 'blocked',
      blockerKind: 'environment',
      summary: '9 permission denials, maxDenials is 5; denied: WebFetch',
    });
  });

  it('names every denied tool once, in the order first denied', () => {
    const denied = { denials: 6, deniedTools: ['Bash(npm test)', 'WebFetch', 'Edit'] };
    const ending = settleAttempt(facts({ exit: { kind: 'stopped' }, ...denied }), limits);
    assert.deepStrictEqual(ending, {
      kind: 'blocked',
      blockerKind: 'environment',
      summary: '6 permission denials, maxDenials is 5; denied: Bash(npm test), WebFetch, Edit',
    });
  });

  it('applies no turn or denial limit the brewer does not set', () => {
    const unlimited = { outDoc: limits.outDoc };
    assert.deepStrictEqual(settleAttempt(facts({ turns: 900, denials: 90 }), unlimited), succeeded);
  });

  it('keeps a garbage line short in the reason', () => {
    const ending = settleAttempt(facts({ garbage: 'x'.repeat(10_000) }), limits);
    assert.equal(ending.kind, 'failed');
    assert.ok(ending.kind === 'failed' && ending.reason.length < 300, 'short reason');
  });

  it('quotes the first 120 characters of a garbage line as JSON', () => {
    const line = `\u001b[31m${'x'.repeat(200)}`;
    assert.deepStrictEqual(settleAttempt(facts({ garbage: line }), limits), {
      kind: 'failed',
      retryable: true,
      reason: `the event stream is not stream-json: "\\u001b[31m${'x'.repeat(115)}"`,
    });
  });

  it('routes a blocked out doc by its blocker kind', () => {
    const blocked = outDoc({
      status: 'blocked',
      summary: 'A test is wrong',
      blockerKind: 'findings',
    });
    assert.deepStrictEqual(settleAttempt(facts({ outDoc: blocked }), limits), {
      kind: 'blocked',
      blockerKind: 'findings',
      summary: 'A test is wrong',
    });
  });

  it("reads the out doc with the brewer's own schema", () => {
    const schema = outDocFrontmatter({ verdict: z.enum(['approve', 'changes']) });
    const review = outDoc({ status: 'done', summary: 'Looks right', verdict: 'approve' });
    const own = { ...limits, outDoc: { file: 'review.md', schema } };
    assert.deepStrictEqual(settleAttempt(facts({ outDoc: review }), own), {
      kind: 'succeeded',
      output: { status: 'done', summary: 'Looks right', assumptions: [], verdict: 'approve' },
    });
    assert.equal(settleAttempt(facts({ outDoc: review }), limits).kind, 'failed');
  });
});

describe('settleAttempt: a brewer that produces commits (ADR 0074)', () => {
  const start = 'c0ffee0'.padEnd(40, '1');
  const committing: AttemptLimits = { ...limits, commitsSince: start };
  const counted = (count: number): CommitsSeen => ({ kind: 'counted', count });

  it('succeeds on a done out doc with a commit after the start', () => {
    assert.deepStrictEqual(settleAttempt(facts({ commits: counted(2) }), committing), succeeded);
  });

  it('blocks on a divergence when the out doc says done but nothing was committed (#196)', () => {
    assert.deepStrictEqual(settleAttempt(facts({ commits: counted(0) }), committing), {
      kind: 'blocked',
      blockerKind: 'divergence',
      summary: 'the out doc says done, but the brewer made no commit since c0ffee0: Planned',
    });
  });

  it('fails, retryably, when the brewer rewrote the commit its worktree started at', () => {
    assert.deepStrictEqual(settleAttempt(facts({ commits: { kind: 'rewritten' } }), committing), {
      kind: 'failed',
      retryable: true,
      reason: 'the brewer rewrote c0ffee0, the commit its worktree started at',
    });
  });

  it('blocks on the environment when git could not count the commits, or nothing counted them', () => {
    const uncounted = { kind: 'uncounted', reason: 'git exited with 128' } as const;
    assert.deepStrictEqual(settleAttempt(facts({ commits: uncounted }), committing), {
      kind: 'blocked',
      blockerKind: 'environment',
      summary: 'the commits since c0ffee0 were not counted: git exited with 128',
    });
    assert.deepStrictEqual(settleAttempt(facts(), committing), {
      kind: 'blocked',
      blockerKind: 'environment',
      summary: 'the commits since c0ffee0 were not counted: the runner did not count them',
    });
  });

  it('reads an out doc that is not done as before, with or without commits', () => {
    const failedDoc = outDoc({ status: 'failed', summary: 'No way through' });
    for (const commits of [counted(0), counted(1), undefined]) {
      const seen = commits === undefined ? {} : { commits };
      assert.deepStrictEqual(settleAttempt(facts({ outDoc: failedDoc, ...seen }), committing), {
        kind: 'failed',
        retryable: true,
        reason: 'the brewer failed: No way through',
      });
    }
  });

  it('puts every earlier rule first: a crash fails as a crash, whatever was committed', () => {
    const crashed = facts({ exit: { kind: 'exited', code: 3 }, commits: counted(0) });
    assert.deepStrictEqual(settleAttempt(crashed, committing), {
      kind: 'failed',
      retryable: true,
      reason: 'the brewer process exited with code 3',
    });
  });

  it('counts no commit for a brewer that does not produce them', () => {
    assert.deepStrictEqual(settleAttempt(facts({ commits: counted(0) }), limits), succeeded);
  });
});
