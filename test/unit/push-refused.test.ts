// A push the secret scan refused (ADR 0079) is a Stuck reason of its own, push_refused (ADR 0418):
// the batch keeps its commit and first findings, by kind, place and line, never the text, and
// waits for `foedrum answer <issue> stop`; the status comment, `foedrum stuck`, `foedrum status`
// and `foedrum replay` show what was found.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatReplay } from '../../src/cli/replay.ts';
import { describeLane, statusRow } from '../../src/cli/status.ts';
import { formatStuck } from '../../src/cli/stuck.ts';
import { admit } from '../../src/engine/admit.ts';
import { type Command, type Context, decide } from '../../src/engine/decide.ts';
import { type Batch, emptyState, fold, type State } from '../../src/engine/fold.ts';
import { laneLabel } from '../../src/engine/lane-labels.ts';
import { PUSH_REFUSED_QUESTION } from '../../src/engine/push-refused.ts';
import { refusedLines, renderStatus } from '../../src/engine/status-comment.ts';
import type { Event, StuckReason } from '../../src/schemas/events.ts';
import type { ScanFinding } from '../../src/schemas/store.ts';
import { fakeRecipe, fakeRecipes, hour } from '../helpers/fake-recipes.ts';

const tip = 'c'.repeat(40);
const other = 'd'.repeat(40);
const now = new Date('2026-11-17T12:00:00.000Z');
const context: Context = {
  now,
  reminderMs: 48 * hour,
  routingMs: hour,
  recipes: fakeRecipes({ ale: fakeRecipe({ steps: ['implement', 'open-pull-request'] }) }),
};
const by = { by: 'ada', via: 'terminal' } as const;
const step = { batchId: 'b1', stepId: 'open-pull-request', attempt: 1 } as const;
const summary =
  'the push of batch b1 stopped before anything left the machine: its commits hold what looks like a secret, or what the scan cannot read (ADR 0079): ' +
  `commit ${tip}, AWS access key id in notes/aws.txt; and 11 more`;

/** Batch b1 brewing ale, its openPullRequest step's attempt started. */
const pushing: Event[] = [
  { type: 'batch.ordered', batchId: 'b1', order: { issue: 12 }, routeBy: '2026-12-31T00:00:00Z' },
  { type: 'batch.recipe_chosen', batchId: 'b1', recipe: 'ale', reason: 'label', source: 'label' },
  { type: 'step.scheduled', ...step, deadlineAt: '2026-11-17T13:00:00.000Z' },
  { type: 'step.started', ...step },
];
/** Twelve findings, out of order across two commits, with and without a line. */
const twelve: ScanFinding[] = [
  { commit: tip, place: 'notes/aws.txt', line: 3, kind: 'AWS access key id' },
  { commit: other, place: 'message', line: 1, kind: 'GitHub token' },
  { commit: tip, place: 'logo.png', kind: 'binary file' },
  ...Array.from({ length: 9 }, (_, i) => ({
    commit: other,
    place: `fixtures/f${i}.txt`,
    line: 20 - i,
    kind: 'GitHub token',
  })),
];
const finish = (refused?: { commit: string; findings: ScanFinding[] }): Command => ({
  kind: 'finish',
  ...step,
  ending: {
    kind: 'blocked',
    blockerKind: 'environment',
    summary,
    ...(refused === undefined ? {} : { refused }),
  },
});
const stuckEvent = (
  events: readonly Event[],
): Extract<Event, { type: 'batch.stuck' }> | undefined =>
  events.find(
    (event): event is Extract<Event, { type: 'batch.stuck' }> => event.type === 'batch.stuck',
  );

const reason: Extract<StuckReason, { kind: 'push_refused' }> = {
  kind: 'push_refused',
  stepId: 'open-pull-request',
  commit: tip,
  findings: twelve.slice(0, 3),
  more: 2,
};
const refusedPush: Event = {
  type: 'batch.stuck',
  batchId: 'b1',
  reason,
  options: ['answer', 'cancel'],
  remindAt: '2026-11-19T12:00:00.000Z',
};
const stuck = (): State => fold([...pushing, refusedPush]);
const answer = (
  ...answers: { q: string; answer: string }[]
): Extract<Command, { kind: 'answer' }> => ({
  kind: 'answer',
  batchId: 'b1',
  ...by,
  answers,
});

describe('decide: a refused push waits as push_refused (ADR 0418)', () => {
  it('makes the batch Stuck with the commit, its first 10 findings and how many more, offering answer and cancel', () => {
    const decision = decide(fold(pushing), finish({ commit: tip, findings: twelve }), context);
    assert.equal(decision.kind, 'accepted', JSON.stringify(decision));
    const event = stuckEvent(decision.kind === 'accepted' ? decision.events : []);
    assert.deepStrictEqual(event?.reason, {
      kind: 'push_refused',
      stepId: 'open-pull-request',
      commit: tip,
      findings: twelve.slice(0, 10),
      more: 2,
    });
    assert.deepStrictEqual(event?.options, ['answer', 'cancel']);
  });

  it('keeps every finding of a refusal under 10, with none more (ADR 0418)', () => {
    const three = twelve.slice(0, 3);
    const decision = decide(fold(pushing), finish({ commit: tip, findings: three }), context);
    const event = stuckEvent(decision.kind === 'accepted' ? decision.events : []);
    assert.deepStrictEqual(
      event?.reason.kind === 'push_refused' ? [event.reason.findings, event.reason.more] : [],
      [three, 0],
    );
  });

  it('answer stop ends the batch as a cancel does', () => {
    const decision = decide(stuck(), answer({ q: PUSH_REFUSED_QUESTION, answer: 'stop' }), context);
    assert.deepStrictEqual(decision, {
      kind: 'accepted',
      events: [{ type: 'batch.cancelled', batchId: 'b1', ...by }],
    });
  });

  it('refuses any answer but stop, another question, and a second answer, saying which it takes', () => {
    const q = PUSH_REFUSED_QUESTION;
    const one = `batch b1 asks one question: ${q}`;
    for (const [answers, why] of [
      [[{ q, answer: 'go' }], 'answer allow "<why>" or stop, not "go"'],
      [[{ q: 'Keep the old endpoint?', answer: 'stop' }], one],
      [
        [
          { q, answer: 'stop' },
          { q, answer: 'stop' },
        ],
        one,
      ],
    ] as const) {
      const decision = decide(stuck(), answer(...answers), context);
      assert.deepStrictEqual(decision, { kind: 'refused', reason: why }, JSON.stringify(answers));
    }
  });
});

describe('a refused push, as people see it (ADR 0418)', () => {
  const batch = stuck().batches.get('b1') as Batch;
  const lines = [
    'AWS access key id on line 3 of cccccccc in notes/aws.txt',
    'GitHub token on line 1 of dddddddd in message',
    'binary file of cccccccc in logo.png',
    'and 2 more',
  ];

  it('the status comment says the push was refused and lists each finding with its line, never the text', () => {
    const text = renderStatus(batch);
    assert.ok(
      text.includes(
        '🔔 **Waiting for you**: answer a question: `open-pull-request`: the push of `cccccccc` was refused before anything left the machine: its commits hold what looks like a secret, or what the scan cannot read (ADR 0079)\n' +
          lines.map((line) => `- ${line}`).join('\n'),
      ),
      text,
    );
  });

  it("the status comment's Next: line names stop alone", () => {
    const next = renderStatus(batch)
      .split('\n')
      .find((line) => line.startsWith('Next:'));
    assert.equal(
      next,
      'Next: look at each finding above, then let the push of this commit go with `foedrum answer 12 allow "<why>"`, or end the batch with `foedrum answer 12 stop`.',
    );
  });

  it('foedrum stuck lists the findings and asks the one question, answered with stop', () => {
    const text = formatStuck(emptyStateWith(batch));
    for (const line of lines) assert.ok(text.includes(`    ${line}\n`), text);
    assert.ok(text.includes(`  1. ${PUSH_REFUSED_QUESTION} (allow "<why>", stop)`), text);
    assert.ok(text.includes('  options: answer, cancel'), text);
  });

  it('foedrum status says it on the batch line, waiting for an answer', () => {
    const { detail } = describeLane(batch, '12');
    assert.ok(
      detail.startsWith(
        `the push of cccccccc at open-pull-request was refused: ${lines.join('; ')}`,
      ),
      detail,
    );
    const [, , state] = statusRow(emptyStateWith(batch), batch);
    assert.equal(state, 'waiting for you');
  });

  it('foedrum replay shows it in the state', () => {
    const text = formatReplay(batch, [{ id: 5, event: refusedPush }]);
    assert.ok(
      text.includes(
        `  lane    stuck: the push of cccccccc at open-pull-request was refused: ${lines[0]}`,
      ),
      text,
    );
  });

  it('says "at least" of the findings past a full ledger list, which may have cut more (ADR 0418)', () => {
    const full = {
      ...reason,
      findings: twelve.slice(0, 10),
      more: 40,
    } satisfies Extract<StuckReason, { kind: 'push_refused' }>;
    assert.equal(refusedLines(full).at(-1), 'and at least 40 more');
    assert.equal(refusedLines({ ...full, more: 39 }).at(-1), 'and 39 more');
  });

  it('names the place last, so a path like an assignment key never hides its line (ADR 0088)', () => {
    const place = 'config/password=';
    const named = {
      ...reason,
      findings: [{ commit: tip, place, line: 3, kind: 'GitHub token' }],
      more: 0,
    } satisfies Extract<StuckReason, { kind: 'push_refused' }>;
    const text = renderStatus({
      ...batch,
      lane: { ...(batch.lane as Extract<Batch['lane'], { kind: 'stuck' }>), reason: named },
    });
    assert.ok(text.includes(`- GitHub token on line 3 of cccccccc in ${place}\n`), text);
  });

  it('carries the label of a batch that waits for an answer', () => {
    assert.equal(laneLabel(batch), 'foedrum:awaiting-answer');
  });
});

describe('decide: allow lets the refused push of its exact commit go (ADR 0419)', () => {
  const why = 'a fake token built in a test fixture';

  it('answer allow with a reason records push.allowed for the refused commit, then schedules the step again', () => {
    const decision = decide(
      stuck(),
      { ...answer({ q: PUSH_REFUSED_QUESTION, answer: 'allow' }), why },
      context,
    );
    assert.equal(decision.kind, 'accepted', JSON.stringify(decision));
    const events = decision.kind === 'accepted' ? decision.events : [];
    assert.deepStrictEqual(events.slice(0, 2), [
      {
        type: 'push.allowed',
        batchId: 'b1',
        stepId: 'open-pull-request',
        commit: tip,
        why,
        ...by,
      },
      { type: 'batch.resumed', batchId: 'b1', ...by, action: 'answer' },
    ]);
    const scheduled = events[2];
    assert.deepStrictEqual(
      scheduled?.type === 'step.scheduled' ? [scheduled.stepId, scheduled.attempt] : scheduled,
      ['open-pull-request', 2],
    );
  });

  it('refuses allow with no reason or a blank one, saying what to type', () => {
    const allow = answer({ q: PUSH_REFUSED_QUESTION, answer: 'allow' });
    for (const command of [allow, { ...allow, why: ' \t ' }]) {
      assert.deepStrictEqual(decide(stuck(), command, context), {
        kind: 'refused',
        reason: 'allow takes a reason: foedrum answer 12 allow "<why>"',
      });
    }
  });

  it('admits push.allowed only on a batch that is Stuck', () => {
    const allowed: Event = {
      type: 'push.allowed',
      batchId: 'b1',
      stepId: 'open-pull-request',
      commit: tip,
      why,
      ...by,
    };
    assert.equal(admit(fold(pushing), [allowed]).kind, 'refused');
    assert.equal(admit(stuck(), [allowed]).kind, 'accepted');
  });
});

describe('a refused push a person allowed, as people see it (ADR 0419)', () => {
  const why = 'a fake token built in a test fixture';
  const allowed: Event[] = [
    { type: 'push.allowed', batchId: 'b1', stepId: 'open-pull-request', commit: tip, why, ...by },
    { type: 'batch.resumed', batchId: 'b1', ...by, action: 'answer' },
    {
      type: 'step.scheduled',
      ...step,
      attempt: 2,
      deadlineAt: '2026-11-17T14:00:00.000Z',
    },
  ];
  const allowedBatch = (): Batch =>
    fold([...pushing, refusedPush, ...allowed]).batches.get('b1') as Batch;

  it("the status comment says under the step's line who allowed the push of which commit, and why", () => {
    const text = renderStatus(allowedBatch());
    assert.ok(
      text.includes(
        '`open-pull-request`: brewing, attempt 2\n  - its push of `cccccccc` was allowed by ada (terminal): a fake token built in a test fixture',
      ),
      text,
    );
  });

  it('leaves a reason that looks like a secret out of the status comment (ADR 0088)', () => {
    // Built at run time, so no scanner takes this file for one that holds a token.
    const token = ['ghp', 'A1b2'.repeat(9)].join('_');
    const secret = fold([
      ...pushing,
      refusedPush,
      { ...(allowed[0] as Event & { type: 'push.allowed' }), why: `it is ${token}` },
      ...allowed.slice(1),
    ]).batches.get('b1') as Batch;
    const text = renderStatus(secret);
    assert.doesNotMatch(text, /A1b2/);
    assert.match(text, /its push of `cccccccc` was allowed by ada \(terminal\): /);
  });

  it('foedrum replay shows the allowance in the state', () => {
    const text = formatReplay(allowedBatch(), [{ id: 6, event: allowed[0] as Event }]);
    assert.ok(text.includes(' push.allowed '), text);
    assert.ok(
      text.includes(
        '  allowed push cccccccc at open-pull-request by ada via terminal: a fake token built in a test fixture\n',
      ),
      text,
    );
  });
});

function emptyStateWith(batch: Batch): State {
  return { ...emptyState, batches: new Map([[batch.id, batch]]) };
}
