// The lasting lines `foedrum serve` prints for what a person must know (ADR 0434): what a batch did
// between two ticks, its cleanup and a failed read of GitHub, in a person's words. Pure: states
// folded from events, no store, no process (ADR 0021).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cleanedLine, lastingLines, readFailureLine } from '../../src/cli/serve-lines.ts';
import { effectKey } from '../../src/engine/effect-key.ts';
import { fold, type State } from '../../src/engine/fold.ts';
import type { Event } from '../../src/schemas/events.ts';

const at = '2026-10-17T12:00:00.000Z';
const web = (number: number) => `https://github.com/acme/web/pull/${number}`;

const ordered = (batchId: string, issue: number, repo?: string): Event => ({
  type: 'batch.ordered',
  batchId,
  order: repo === undefined ? { issue } : { issue, repo },
  routeBy: at,
});
const chosen = (batchId: string): Event => ({
  type: 'batch.recipe_chosen',
  batchId,
  recipe: 'stout',
  reason: 'label',
  source: 'label',
});
/** A step's attempt that is scheduled and started: it runs. */
const running = (batchId: string, stepId: string, attempt = 1): Event[] => [
  { type: 'step.scheduled', batchId, stepId, attempt, deadlineAt: at },
  { type: 'step.started', batchId, stepId, attempt },
];
const succeeded = (
  batchId: string,
  stepId: string,
  attempt = 1,
  more: Partial<Extract<Event, { type: 'step.finished' }>> = {},
): Event => ({
  type: 'step.finished',
  batchId,
  stepId,
  attempt,
  outcome: { kind: 'succeeded', output: { status: 'done', summary: 'Brewed' } },
  ...more,
});
const stuck = (batchId: string, remindAt = at): Event => ({
  type: 'batch.stuck',
  batchId,
  reason: {
    kind: 'blocked',
    stepId: 'brew',
    blockerKind: 'environment',
    summary: 'claude is not installed',
  },
  options: ['retry', 'cancel'],
  remindAt,
});
const onTap = (batchId: string, ...pullRequests: string[]): Event => ({
  type: 'batch.on_tap',
  batchId,
  pullRequests,
});
const ended = (batchId: string, pullRequest: string, state: 'merged' | 'closed'): Event => ({
  type: 'pull_request.ended',
  batchId,
  pullRequest,
  state,
});
const applied = (batchId: string, effect: string, result: unknown): Event => ({
  type: 'effect.applied',
  key: effectKey.encode({ batchId, effect }),
  result,
});

const usage = {
  inputTokens: 1200,
  outputTokens: 340,
  cacheReadTokens: 56_000,
  cacheWriteTokens: 780,
};
const receipt = {
  complete: true,
  durationMs: 125_000,
  apiDurationMs: 90_000,
  turns: 12,
  edits: 3,
  toolErrors: 0,
  denied: [],
};

/** The lines from the state `events` fold to, to the state `then` takes it to. */
const between = (events: Event[], then: Event[]): string[] => {
  const before: State = fold(events);
  return lastingLines(before, fold(then, before));
};

/** A Brewery issue's batch that brews its `brew` step. */
const brewing: Event[] = [ordered('12-1', 12), chosen('12-1'), ...running('12-1', 'brew')];

describe('lastingLines', () => {
  describe('a step that ended (ADR 0434)', () => {
    it("says the step and its attempt, how long it took and the tokens it used, from the attempt's receipt and usage", () => {
      const lines = between(brewing, [succeeded('12-1', 'brew', 1, { usage, receipt })]);
      assert.equal(lines.length, 1, lines.join('\n'));
      const [line = ''] = lines;
      assert.match(line, /^#12 /);
      assert.match(line, /\bbrew #1\b/);
      assert.match(line, /\bsucceeded\b/);
      assert.match(line, /\b2m 5s\b/);
      assert.match(line, /\b1,200 input\b/);
      assert.match(line, /\b340 output\b/);
    });

    it('says a failed attempt failed', () => {
      const failed: Event = {
        type: 'step.finished',
        batchId: '12-1',
        stepId: 'brew',
        attempt: 1,
        outcome: { kind: 'failed', retryable: false, reason: 'claude was not found on PATH' },
      };
      const [line = ''] = between(brewing, [failed]).filter((each) => each.includes('brew #1'));
      assert.match(line, /^#12 brew #1 /);
      assert.match(line, /\bfailed\b/);
    });

    it('names a step that reports no time and no tokens, and invents neither', () => {
      const checking = [ordered('12-1', 12), chosen('12-1'), ...running('12-1', 'green')];
      const lines = between(checking, [succeeded('12-1', 'green')]);
      assert.equal(lines.length, 1, lines.join('\n'));
      const [line = ''] = lines;
      assert.match(line, /^#12 green #1 /);
      assert.doesNotMatch(line, /undefined|NaN|\binput\b|\boutput\b/);
    });

    it('says each of the attempts that ended between two ticks, in the order they ran', () => {
      const lines = between(
        [
          ordered('12-1', 12),
          chosen('12-1'),
          ...running('12-1', 'brew'),
          ...running('12-1', 'green'),
        ],
        [succeeded('12-1', 'brew'), succeeded('12-1', 'green')],
      );
      assert.equal(lines.length, 2, lines.join('\n'));
      assert.match(lines[0] ?? '', /\bbrew #1\b/);
      assert.match(lines[1] ?? '', /\bgreen #1\b/);
    });
  });

  describe('a batch that got Stuck (ADR 0434)', () => {
    it('says what it is Stuck for and each command to type to move it on', () => {
      const lines = between(brewing, [stuck('12-1')]);
      assert.equal(lines.length, 1, lines.join('\n'));
      const [line = ''] = lines;
      assert.match(line, /^#12 is stuck\b/);
      assert.match(line, /blocked at brew/);
      assert.match(line, /claude is not installed/);
      assert.ok(line.includes('foedrum retry 12'), line);
      assert.ok(line.includes('foedrum cancel 12'), line);
    });

    it('says it once: a reminder that makes it Stuck again for the same reason adds no line', () => {
      const before = [...brewing, stuck('12-1')];
      const lines = between(before, [stuck('12-1', '2026-10-18T12:00:00.000Z')]);
      assert.deepStrictEqual(lines, []);
    });

    it('says it again when it was moved on and got Stuck again', () => {
      const resumed: Event = {
        type: 'batch.resumed',
        batchId: '12-1',
        by: 'ann',
        via: 'terminal',
        action: 'retry',
      };
      const lines = between(
        [...brewing, stuck('12-1')],
        [resumed, ...running('12-1', 'brew', 2), stuck('12-1')],
      );
      assert.equal(lines.filter((line) => line.includes('is stuck')).length, 1, lines.join('\n'));
    });
  });

  describe('a pull request (ADR 0434)', () => {
    const tapped = [...brewing, succeeded('12-1', 'brew')];

    it('says it opened, with its link', () => {
      const lines = between(tapped, [onTap('12-1', web(7))]);
      assert.equal(lines.length, 1, lines.join('\n'));
      assert.equal(lines[0], `#12 opened pull request ${web(7)}`);
    });

    it('says each of the pull requests a batch opened', () => {
      const lines = between(tapped, [onTap('12-1', web(7), web(8))]);
      const text = lines.join('\n');
      assert.ok(text.includes(web(7)), text);
      assert.ok(text.includes(web(8)), text);
    });

    it("names a claimed order by its Brewery issue and its target issue's alias", () => {
      const claimed = [
        ordered('web-7', 7, 'acme/web'),
        applied('web-7', 'order.issue', 27),
        chosen('web-7'),
        ...running('web-7', 'brew'),
        succeeded('web-7', 'brew'),
      ];
      const lines = between(claimed, [onTap('web-7', web(31))]);
      assert.deepStrictEqual(lines, [`#27 (web#7) opened pull request ${web(31)}`]);
    });

    it('says a batch that is on tap with no pull request opened none', () => {
      const lines = between(tapped, [onTap('12-1')]);
      assert.deepStrictEqual(lines, []);
    });

    it('says it merged', () => {
      const lines = between([...tapped, onTap('12-1', web(7))], [ended('12-1', web(7), 'merged')]);
      assert.equal(lines.length, 1, lines.join('\n'));
      assert.match(lines[0] ?? '', /^#12 /);
      assert.ok((lines[0] ?? '').includes(web(7)), lines[0]);
      assert.match(lines[0] ?? '', /\bmerged\b/);
    });

    it('says it was closed without merging', () => {
      const lines = between([...tapped, onTap('12-1', web(7))], [ended('12-1', web(7), 'closed')]);
      assert.equal(lines.length, 1, lines.join('\n'));
      assert.ok((lines[0] ?? '').includes(web(7)), lines[0]);
      assert.match(lines[0] ?? '', /\bclosed\b/);
      assert.doesNotMatch(lines[0] ?? '', /\bmerged\b/);
    });

    it('says the end of the one of two pull requests that ended, and only that one', () => {
      const lines = between(
        [...tapped, onTap('12-1', web(7), web(8))],
        [ended('12-1', web(8), 'merged')],
      );
      assert.equal(lines.length, 1, lines.join('\n'));
      assert.ok((lines[0] ?? '').includes(web(8)), lines[0]);
      assert.ok(!(lines[0] ?? '').includes(web(7)), lines[0]);
    });
  });

  describe('what stays as it was (ADR 0434)', () => {
    it('says nothing for a batch whose state did not change', () => {
      const state = fold([...brewing, stuck('12-1')]);
      assert.deepStrictEqual(lastingLines(state, state), []);
    });

    it('says nothing a second time for a change it said once', () => {
      const before = fold(brewing);
      const after = fold([succeeded('12-1', 'brew', 1, { usage, receipt })], before);
      assert.equal(lastingLines(before, after).length, 1);
      assert.deepStrictEqual(lastingLines(after, after), []);
    });

    it("says each batch's change under its own name", () => {
      const both = [...brewing, ordered('13-1', 13), chosen('13-1'), ...running('13-1', 'brew')];
      const lines = between(both, [stuck('12-1'), onTap('13-1', web(9))]);
      assert.equal(lines.length, 2, lines.join('\n'));
      assert.ok(
        lines.some((line) => /^#12 is stuck/.test(line)),
        lines.join('\n'),
      );
      assert.ok(
        lines.some((line) => line.startsWith('#13 opened pull request')),
        lines.join('\n'),
      );
    });
  });
});

describe('cleanedLine', () => {
  const worktrees = (batchId: string, count: number): string[] =>
    Array.from({ length: count }, (_, i) => `removed worktree ${batchId}/brew/${i + 1}`);
  const branches = (batchId: string, count: number): string[] =>
    Array.from({ length: count }, (_, i) => `deleted branch foedrum/${batchId}/brew/${i + 1}`);
  const report = (batchId: string, done: string[], kept: string[] = [], failed: string[] = []) =>
    ({ kind: 'cleaned', batchId, report: { done, kept, failed } }) as const;

  it("says a claimed batch's cleanup as its order, its pull request and what it keeps, in the words of a person", () => {
    const state = fold([
      ordered('foedrum-1156', 1156, 'acme/foedrum'),
      applied('foedrum-1156', 'order.issue', 27),
      chosen('foedrum-1156'),
      ...running('foedrum-1156', 'brew'),
      succeeded('foedrum-1156', 'brew'),
      onTap('foedrum-1156', 'https://github.com/acme/foedrum/pull/1167'),
    ]);
    const line = cleanedLine(
      report(
        'foedrum-1156',
        [
          ...worktrees('foedrum-1156', 20),
          ...branches('foedrum-1156', 19),
          'removed batch folder foedrum-1156',
          'removed attempt settings foedrum-1156',
        ],
        [
          'kept branch foedrum/foedrum-1156/brew/20: it holds the task tree of batch foedrum-1156, whose pull request is open (ADR 0219)',
        ],
      ),
      state,
    );
    assert.equal(
      line,
      '#27 (foedrum#1156) opened pull request #1167; cleaned its 20 working copies, keeping its last branch in case a check on the pull request fails',
    );
  });

  describe('for a batch of a Brewery issue', () => {
    const tapped = fold([
      ordered('12-1', 12),
      chosen('12-1'),
      ...running('12-1', 'brew'),
      succeeded('12-1', 'brew'),
      onTap('12-1', web(7)),
    ]);

    it('counts one working copy in the singular, and keeps nothing to say of a branch it did not keep', () => {
      const line = cleanedLine(
        report('12-1', [...worktrees('12-1', 1), ...branches('12-1', 1)]),
        tapped,
      );
      assert.equal(line, '#12 opened pull request #7; cleaned its 1 working copy');
    });

    it('says a cleanup of a batch with no pull request without one', () => {
      const none = fold([
        ordered('12-1', 12),
        chosen('12-1'),
        ...running('12-1', 'brew'),
        succeeded('12-1', 'brew'),
        onTap('12-1'),
      ]);
      const line = cleanedLine(report('12-1', worktrees('12-1', 2)), none);
      assert.equal(line, '#12 cleaned its 2 working copies');
    });

    it('goes on to say what it could not clean', () => {
      const line = cleanedLine(
        report('12-1', worktrees('12-1', 2), [], ['could not clean 12-1/x: busy']),
        tapped,
      );
      assert.match(line, /^#12 opened pull request #7; cleaned its 2 working copies/);
      assert.ok(line.includes('could not clean 12-1/x: busy'), line);
    });

    it("leaves out the engine's own words: the batch id and its counts of branches and folders", () => {
      const line = cleanedLine(
        report('12-1', [
          ...worktrees('12-1', 3),
          ...branches('12-1', 2),
          'removed batch folder 12-1',
          'removed attempt settings 12-1',
        ]),
        tapped,
      );
      assert.match(line, /cleaned its 3 working copies/);
      assert.ok(!line.includes('12-1'), line);
      assert.ok(!line.includes('cleaned batch'), line);
    });
  });
});

describe('readFailureLine', () => {
  const failure = {
    kind: 'failed',
    what: 'listing Acme/Brewery',
    error: new Error('GitHub answered 500 to listing Acme/Brewery: a flaky wire'),
  } as const;

  it('says in one line what failed and that the next pass tries again, with no raw error, where a live line is drawn', () => {
    const line = readFailureLine(failure, true);
    assert.ok(!/[\r\n]/.test(line), JSON.stringify(line));
    assert.ok(line.includes('listing Acme/Brewery'), line);
    assert.match(line, /the next pass tries again/);
    assert.ok(!line.includes('a flaky wire'), line);
    assert.ok(!line.includes('GitHub answered'), line);
  });

  it('adds the raw error to that where no live line is drawn', () => {
    const line = readFailureLine(failure, false);
    assert.ok(line.includes('listing Acme/Brewery'), line);
    assert.ok(line.includes('GitHub answered 500 to listing Acme/Brewery: a flaky wire'), line);
    assert.match(line, /the next pass tries again/);
  });

  it('keeps the words of a failure the intake names `the intake failed` where no live line is drawn', () => {
    assert.match(readFailureLine(failure, false), /^the intake failed listing Acme\/Brewery: /);
  });

  it('keeps a localised or multi-line socket error off the live line, whatever it says', () => {
    const socket = {
      kind: 'failed',
      what: 'reading https://github.com/acme/web/pull/1167',
      error: new Error(
        'gh could not ask GitHub for GET /repos/acme/web/pulls/1167: read tcp: wsarecv: Een verbindingspoging is mislukt\nsecond line',
      ),
    } as const;
    const line = readFailureLine(socket, true);
    assert.ok(line.includes('reading https://github.com/acme/web/pull/1167'), line);
    assert.ok(!/[\r\n]/.test(line), JSON.stringify(line));
    assert.ok(!line.includes('wsarecv'), line);
    assert.match(line, /the next pass tries again/);
  });
});
