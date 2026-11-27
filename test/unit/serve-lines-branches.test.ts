// The branches of serve's lasting lines (ADR 0434) that a plain brew, a plain cleanup or a
// single pull request does not reach. Pure: states folded from events (ADR 0021).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cleanedLine, lastingLines } from '../../src/cli/serve-lines.ts';
import { fold, type State } from '../../src/engine/fold.ts';
import type { Event } from '../../src/schemas/events.ts';

const at = '2026-10-17T12:00:00.000Z';
const web = (number: number) => `https://github.com/acme/web/pull/${number}`;
/** The line separator and the paragraph separator, which end a line as a line feed does. */
const separators = String.fromCharCode(0x2028, 0x2029);

const setup: Event[] = [
  { type: 'batch.ordered', batchId: '12-1', order: { issue: 12 }, routeBy: at },
  {
    type: 'batch.recipe_chosen',
    batchId: '12-1',
    recipe: 'stout',
    reason: 'label',
    source: 'label',
  },
  { type: 'step.scheduled', batchId: '12-1', stepId: 'brew', attempt: 1, deadlineAt: at },
  { type: 'step.started', batchId: '12-1', stepId: 'brew', attempt: 1 },
];
const finished = (more: Partial<Extract<Event, { type: 'step.finished' }>>): Event => ({
  type: 'step.finished',
  batchId: '12-1',
  stepId: 'brew',
  attempt: 1,
  outcome: { kind: 'succeeded', output: { status: 'done', summary: 'Brewed' } },
  ...more,
});
const between = (then: Event[]): string[] => {
  const before: State = fold(setup);
  return lastingLines(before, fold(then, before));
};
const tapped = (...pullRequests: string[]): State =>
  fold([...setup, finished({}), { type: 'batch.on_tap', batchId: '12-1', pullRequests }]);
const cleaning = (done: string[], kept: string[] = [], failed: string[] = []) =>
  ({ kind: 'cleaned', batchId: '12-1', report: { done, kept, failed } }) as const;

describe('lastingLines of one batch', () => {
  it('says the time of a step that reports one and no tokens', () => {
    const receipt = {
      complete: true,
      durationMs: 61_000,
      turns: 1,
      edits: 0,
      toolErrors: 0,
      denied: [],
    };
    assert.deepStrictEqual(between([finished({ receipt })]), ['#12 brew #1 succeeded (1m 1s)']);
  });

  it('says the tokens of a step that reports no time', () => {
    const usage = { inputTokens: 5, outputTokens: 6, cacheReadTokens: 0, cacheWriteTokens: 0 };
    assert.deepStrictEqual(between([finished({ usage })]), [
      '#12 brew #1 succeeded (5 input, 6 output tokens)',
    ]);
  });

  it('says a step that needs input in words', () => {
    const asking = finished({
      outcome: {
        kind: 'needs_input',
        questions: [
          { q: 'Which one?', options: ['a', 'b'], recommended: 'a', whyBlocking: 'Both fit' },
        ],
      },
    });
    assert.deepStrictEqual(between([asking]), ['#12 brew #1 needs input']);
  });

  it('keeps what a model wrote on the one line of its Stuck', () => {
    const [line = ''] = between([
      {
        type: 'batch.stuck',
        batchId: '12-1',
        reason: {
          kind: 'blocked',
          stepId: 'brew',
          blockerKind: 'environment',
          summary: `one\ntwo${separators}three`,
        },
        options: ['retry'],
        remindAt: at,
      },
    ]);
    assert.ok(line.includes('one two three'), JSON.stringify(line));
    assert.equal(line.split(/[\r\n]/).length, 1, JSON.stringify(line));
    for (const separator of separators) assert.ok(!line.includes(separator), JSON.stringify(line));
  });

  it('says a pull request that opened after another, and only the new one', () => {
    const before = tapped(web(7));
    const after = fold(
      [{ type: 'batch.on_tap', batchId: '12-1', pullRequests: [web(7), web(8)] }],
      before,
    );
    assert.deepStrictEqual(lastingLines(before, after), [`#12 opened pull request ${web(8)}`]);
  });

  describe('a batch sent back to brew a fix and put on tap again with its pull request', () => {
    const rewound: Event = {
      type: 'batch.rewound',
      batchId: '12-1',
      toStepId: 'brew',
      by: 'octocat',
      via: 'terminal',
      shas: {},
    };
    const tappedAgain: Event = { type: 'batch.on_tap', batchId: '12-1', pullRequests: [web(7)] };

    it('says it opened once, over the ticks of the fix round', () => {
      const announced = new Set<string>();
      const first = fold(setup);
      const onTap = tapped(web(7));
      const brewing = fold([rewound], onTap);
      const again = fold([tappedAgain], brewing);
      assert.deepStrictEqual(lastingLines(first, onTap, announced).slice(-1), [
        `#12 opened pull request ${web(7)}`,
      ]);
      assert.deepStrictEqual(lastingLines(onTap, brewing, announced), []);
      assert.deepStrictEqual(lastingLines(brewing, again, announced), []);
    });

    it('says nothing of a pull request that was open when serve began', () => {
      const announced = new Set<string>();
      const onTap = tapped(web(7));
      const brewing = fold([rewound], onTap);
      assert.deepStrictEqual(lastingLines(onTap, brewing, announced), []);
      assert.deepStrictEqual(lastingLines(brewing, fold([tappedAgain], brewing), announced), []);
    });
  });

  it('says the end of a pull request that the first tick did not know', () => {
    const before = tapped(web(7));
    const after = fold(
      [{ type: 'pull_request.ended', batchId: '12-1', pullRequest: web(7), state: 'merged' }],
      before,
    );
    assert.deepStrictEqual(lastingLines(before, after), [`#12 pull request ${web(7)} was merged`]);
  });
});

describe('cleanedLine of one batch', () => {
  it('names the pull requests of a batch that opened two', () => {
    const line = cleanedLine(cleaning(['removed worktree 12-1/brew/1']), tapped(web(7), web(8)));
    assert.equal(line, '#12 opened pull request #7, #8; cleaned its 1 working copy');
  });

  it('says a cleanup that removed no working copy without the opening of the pull request', () => {
    const line = cleanedLine(cleaning(['removed batch folder 12-1']), tapped(web(7)));
    assert.equal(line, '#12 cleaned nothing');
  });

  it('says a branch it kept for another reason as the engine does, not as its last branch', () => {
    const other = 'kept branch foedrum/12-1/brew/1: checked out in /somewhere';
    const line = cleanedLine(cleaning(['removed worktree 12-1/brew/2'], [other]), tapped(web(7)));
    assert.equal(line, `#12 opened pull request #7; cleaned its 1 working copy; ${other}`);
  });
});
