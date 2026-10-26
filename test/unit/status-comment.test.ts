// The status comment of a batch of a Brewery issue (architecture §8, ADR 0072): its text rendered
// from plain folded batches, and its revisions applied through the ledger by a driver, with a fake
// of the comments host. Nothing reaches GitHub (ADR 0021).

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { effectMarker } from '../../src/engine/claim-effects.ts';
import { type CommandLog, createCommandLog } from '../../src/engine/command-log.ts';
import type { Ending } from '../../src/engine/decide.ts';
import { type Driver, type DriverNotice, openDriver } from '../../src/engine/driver.ts';
import { effectKey } from '../../src/engine/effect-key.ts';
import type { EventStore } from '../../src/engine/event-store.ts';
import type { Attempt, Batch, Lane, Step } from '../../src/engine/fold.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import {
  renderStatus,
  type StatusComments,
  statusEffects,
} from '../../src/engine/status-comment.ts';
import type { StuckReason } from '../../src/schemas/events.ts';
import { defaultLimits } from '../helpers/brewing.ts';
import { fakeLock } from '../helpers/fake-lock.ts';
import { fakeRecipe, fakeRecipes } from '../helpers/fake-recipes.ts';

const at = '2026-10-18T09:00:00.000Z';
// Built at run time, so no scanner takes this file for one that holds a token.
const token = ['ghp', 'A1b2'.repeat(9)].join('_');
/** `text` as a regular expression that matches it literally. */
const escaped = (text: string): string => text.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
/** The line left in place of a text of `stepId` that looks like a secret, as shown and as a pattern. */
const leftOut = (stepId: string) =>
  `\\[left out: a text of step ${stepId} that looks like a secret\\]`;
const noToken = (text: string) => assert.doesNotMatch(text, /ghp|A1b2/);
const pr = 'https://github.com/alice/web/pull/12';

const done = (attempt: number, assumptions: string[] = []): Attempt => ({
  phase: 'finished',
  attempt,
  deadlineAt: at,
  outcome: { kind: 'succeeded', output: { status: 'done', summary: 'Done', assumptions } },
});
const failed = (attempt: number, reason: string): Attempt => ({
  phase: 'finished',
  attempt,
  deadlineAt: at,
  outcome: { kind: 'failed', retryable: true, reason },
});
const running = (attempt: number): Attempt => ({ phase: 'started', attempt, deadlineAt: at });
const step = (id: string, ...attempts: Attempt[]): [string, Step] => [
  id,
  { id, attempts: new Map(attempts.map((each) => [each.attempt, each])), inputs: [] },
];
const batch = (fields: Partial<Batch> = {}): Batch => ({
  id: '7-1',
  issue: 7,
  recipe: { name: 'nip', reason: 'label', source: 'label' },
  lane: { kind: 'brewing' },
  steps: new Map(),
  rewinds: [],
  ...fields,
}); /** An Ordered batch, which no recipe brews yet. */
const ordered = (): Batch => {
  const { recipe: _, ...rest } = batch({ lane: { kind: 'ordered', routeBy: at } });
  return rest;
};
const stuck = (reason: StuckReason, remindAt = at): Lane => ({
  kind: 'stuck',
  reason,
  options: ['retry', 'cancel'],
  remindAt,
});
const steps = ['plan', 'brew', 'taste'];
/** The line of `text` that names the step `id`. */
const lineOf = (text: string, id: string): string =>
  text.split('\n').find((line) => line.includes(`\`${id}\``)) ?? '';

describe('renderStatus', () => {
  it('says a paused batch is Paused, with who, from where, why and when what runs is stopped (ADR 0202)', () => {
    const pause = {
      by: 'ada',
      via: 'terminal',
      why: 'end of the day',
      stopAt: { at: '2026-10-18T15:30:00.000Z', zone: 'Europe/Brussels' },
    } as const;
    const lines = renderStatus(batch(), steps, undefined, pause).split('\n');
    const lane = lines.indexOf('🍺 **Brewing**');
    assert.ok(lane > 0);
    assert.equal(
      lines[lane + 1],
      '⏸️ **Paused** by ada (terminal): end of the day. Nothing new starts; what runs ends at its next convenient point, and what still runs at 15:30 UTC (17:30 Europe/Brussels, 18 October) is stopped.',
    );
    const plain = renderStatus(batch(), steps, undefined, { by: 'ada', via: 'plugin' });
    assert.match(
      plain,
      /⏸️ \*\*Paused\*\* by ada \(plugin\)\. Nothing new starts; what runs ends at its next convenient point\.\n/,
    );
    assert.doesNotMatch(renderStatus(batch(), steps), /Paused/);
  });

  it('says the usage window is closed, which limit, its reset and when brewers start again (ADR 0206)', () => {
    const closed = {
      limit: 'weekly',
      resets: 'Mon 12:00am',
      reopensAt: '2026-10-25T23:05:00.000Z',
      read: true,
    } as const;
    const lines = renderStatus(batch(), steps, undefined, undefined, undefined, closed).split('\n');
    const lane = lines.indexOf('🍺 **Brewing**');
    assert.ok(lane > 0);
    assert.equal(
      lines[lane + 1],
      '⏳ Usage window closed: claude hit its weekly limit, which resets Mon 12:00am; brewers wait until 23:05 UTC, 25 October.',
    );
    const unread = renderStatus(batch(), steps, undefined, undefined, undefined, {
      ...closed,
      resets: 'soon <b>',
      read: false,
    });
    assert.match(
      unread,
      /⏳ Usage window closed: claude hit its weekly limit, which resets soon &lt;b&gt;; brewers try again at 23:05 UTC, 25 October\./,
    );
    assert.doesNotMatch(
      renderStatus(ordered(), undefined, undefined, undefined, undefined, closed),
      /Usage window/,
    );
    assert.doesNotMatch(renderStatus(batch(), steps), /Usage window/);
  });

  it("escapes a pause's reason as any text an issue wrote (ADR 0202)", () => {
    const text = renderStatus(batch(), steps, undefined, {
      by: 'ada',
      via: 'terminal',
      why: '@team <b>stop</b>\nnow',
    });
    assert.match(text, /: &#64;team &lt;b&gt;stop&lt;\/b&gt; now\. Nothing new starts/);
  });

  it('names the batch, and says an Ordered batch has no recipe chosen yet', () => {
    const text = renderStatus(ordered(), undefined);
    assert.match(text, /`7-1`/);
    assert.match(text, /Ordered/);
    assert.match(text, /no recipe is chosen yet/i);
  });

  it("lists the recipe's steps in order, marking the done, the current and the unreached", () => {
    const text = renderStatus(
      batch({
        steps: new Map([step('plan', done(1)), step('brew', failed(1, 'crash'), running(2))]),
      }),
      steps,
    );
    assert.match(text, /\*\*nip\*\*/);
    assert.match(lineOf(text, 'plan'), /✅/);
    assert.match(lineOf(text, 'brew'), /▶️.*attempt 2/);
    assert.match(lineOf(text, 'taste'), /⬜/);
    const order = steps.map((id) => text.indexOf(`\`${id}\``));
    assert.deepEqual(
      order,
      [...order].sort((a, b) => a - b),
    );
  });

  // ADR 0175: a retry after the turn budget ran out goes on in the same session.
  it('says a running attempt resumed after the turn budget, and only then', () => {
    const overran: Attempt = {
      phase: 'finished',
      attempt: 1,
      deadlineAt: at,
      outcome: {
        kind: 'failed',
        retryable: true,
        reason: 'budget exceeded: 81 turns, maxTurns is 80',
        overran: 'turns',
      },
    };
    const id = '0f8fad5b-d9cb-469f-a165-708677289500';
    const resumed: Attempt = {
      phase: 'started',
      attempt: 2,
      deadlineAt: at,
      session: { id, resumes: id, worktree: 'work/7-1/brew/1' },
    };
    const text = renderStatus(batch({ steps: new Map([step('brew', overran, resumed)]) }), steps);
    assert.equal(
      lineOf(text, 'brew'),
      '- ▶️ `brew`: brewing, attempt 2, resumed after the turn budget',
    );
    const crashed = renderStatus(
      batch({ steps: new Map([step('brew', failed(1, 'crash'), resumed)]) }),
      steps,
    );
    assert.equal(lineOf(crashed, 'brew'), '- ▶️ `brew`: brewing, attempt 2');
  });

  it('marks a skipped step and a failed one', () => {
    const text = renderStatus(
      batch({
        lane: stuck({
          kind: 'attempts_exhausted',
          stepId: 'brew',
          attempts: 2,
          lastReason: 'crash',
        }),
        steps: new Map([step('brew', failed(1, 'crash'), failed(2, 'crash'))]),
        skipped: new Set(['plan']),
      }),
      steps,
    );
    assert.match(lineOf(text, 'plan'), /skipped/);
    assert.match(lineOf(text, 'brew'), /🔔/);
  });

  it('shows the attempts in the order they ran on one line before the steps (#406)', () => {
    const text = renderStatus(
      batch({
        lane: stuck({ kind: 'blocked', stepId: 'gauge', blockerKind: 'environment', summary: 'x' }),
        steps: new Map([
          step('gauge', done(1), failed(2, 'blocked')),
          step('red', failed(1, 'passes')),
        ]),
        path: [
          { stepId: 'gauge', attempt: 1 },
          { stepId: 'red', attempt: 1 },
          { stepId: 'gauge', attempt: 2 },
        ],
      }),
      ['gauge', 'red', 'implement'],
    );
    const lines = text.split('\n');
    const path = lines.indexOf('Path: `gauge #1` ✅ → `red #1` ❌ → `gauge #2` 🔔');
    assert.ok(path >= 0, text);
    const firstStep = lines.findIndex((line) => line.startsWith('- ') && line.includes('`gauge`'));
    assert.ok(path < firstStep, 'the path comes before the steps');
    assert.doesNotMatch(renderStatus(batch(), steps), /Path:/);
  });

  it('marks a running, a stopped and an asking attempt on the path (#406)', () => {
    const asked: Attempt = {
      phase: 'finished',
      attempt: 1,
      deadlineAt: at,
      outcome: {
        kind: 'needs_input',
        questions: [{ q: 'Which?', options: ['a', 'b'], recommended: 'a', whyBlocking: 'x' }],
      },
    };
    const stopped: Attempt = { phase: 'started', attempt: 1, deadlineAt: at, abandoned: true };
    const text = renderStatus(
      batch({
        steps: new Map([step('plan', asked), step('brew', stopped), step('taste', running(1))]),
        path: [
          { stepId: 'plan', attempt: 1 },
          { stepId: 'brew', attempt: 1 },
          { stepId: 'taste', attempt: 1 },
        ],
      }),
      steps,
    );
    assert.ok(text.split('\n').includes('Path: `plan #1` ❓ → `brew #1` ⏹️ → `taste #1` ▶️'), text);
  });

  it('ends the path where the batch is Stuck, though that attempt never started (#406)', () => {
    const scheduled: Attempt = { phase: 'scheduled', attempt: 2, deadlineAt: at };
    const text = renderStatus(
      batch({
        lane: stuck({ kind: 'waiting_for_session', stepId: 'gauge' }),
        steps: new Map([step('gauge', done(1), scheduled)]),
        path: [{ stepId: 'gauge', attempt: 1 }],
      }),
      ['gauge'],
    );
    assert.ok(text.split('\n').includes('Path: `gauge #1` ✅ → `gauge #2` 🔔'), text);
  });

  it('lists the steps the batch has when its recipe is unknown', () => {
    const text = renderStatus(batch({ steps: new Map([step('mash', done(1))]) }), undefined);
    assert.match(lineOf(text, 'mash'), /✅/);
  });

  it('says why a Stuck batch is stuck, at which step, and what gets it moving', () => {
    const text = renderStatus(
      batch({
        lane: stuck({
          kind: 'blocked',
          stepId: 'brew',
          blockerKind: 'environment',
          summary: 'npm is missing',
        }),
        steps: new Map([step('plan', done(1)), step('brew', failed(1, 'npm is missing'))]),
      }),
      steps,
    );
    assert.match(text, /Stuck/);
    assert.match(text, /environment/);
    assert.match(text, /npm is missing/);
    assert.match(lineOf(text, 'brew'), /🔔/);
    assert.match(text, /`retry`.*`cancel`/);
  });

  // An event written before ADR 0192, or by a step with no findings route, has no roundsOut.
  it('shows a findings blocker without rounds as it always did, with no open findings or step-back', () => {
    const reason: StuckReason = {
      kind: 'blocked',
      stepId: 'taste',
      blockerKind: 'findings',
      summary: 'the Taster asks for changes: no deadline',
    };
    const lines = renderStatus(batch({ lane: stuck(reason) }), steps).split('\n');
    const at_ = lines.findIndex((line) => line.startsWith('🔔'));
    assert.deepStrictEqual(lines.slice(at_, at_ + 3), [
      '🔔 **Stuck**: `taste` is blocked (findings): the Taster asks for changes: no deadline',
      'Get it moving with `retry`, `cancel`.',
      '',
    ]);
  });

  it('lists the open findings of a findings route that ran out of rounds, and recommends stepping back (ADR 0192)', () => {
    const reason: StuckReason = {
      kind: 'blocked',
      stepId: 'taste',
      blockerKind: 'findings',
      summary: 'the Taster asks for changes: no deadline',
      roundsOut: {
        rounds: 2,
        open: [
          {
            file: 'src/a_b.ts',
            line: 3,
            severity: 'major',
            why: 'no\n# deadline',
            introduced: true,
          },
          { severity: 'minor', why: 'x'.repeat(300), introduced: false },
          { severity: 'blocker', why: `Token ${token}`, introduced: true },
        ],
        more: 4,
      },
    };
    const lines = renderStatus(batch({ lane: stuck(reason) }), steps).split('\n');
    const at_ = lines.findIndex((line) => line.startsWith('🔔'));
    assert.deepStrictEqual(lines.slice(at_, at_ + 9), [
      '🔔 **Stuck**: `taste` is blocked (findings): the Taster asks for changes: no deadline',
      'Still open after 2 rounds:',
      '- `taste`: major in src/a\\_b.ts:3: no \\# deadline',
      `- \`taste\`: minor, there before the change: ${'x'.repeat(199)}…`,
      `- \`taste\`: blocker: ${leftOut('taste')}`,
      '- `taste`: and 4 more',
      'Another round is unlikely to help: plan the order again, or split it.',
      'Get it moving with `retry`, `cancel`.',
      '',
    ]);
    noToken(lines.join('\n'));
  });

  it('says one round, and that the last round recorded no finding (ADR 0192)', () => {
    const reason: StuckReason = {
      kind: 'blocked',
      stepId: 'taste',
      blockerKind: 'findings',
      summary: 'the Taster asks for changes: no deadline',
      roundsOut: { rounds: 1, open: [], more: 0 },
    };
    const lines = renderStatus(batch({ lane: stuck(reason) }), steps).split('\n');
    const at_ = lines.findIndex((line) => line.startsWith('🔔'));
    assert.deepStrictEqual(lines.slice(at_ + 1, at_ + 4), [
      'Still open after 1 round: no finding was recorded.',
      'Another round is unlikely to help: plan the order again, or split it.',
      'Get it moving with `retry`, `cancel`.',
    ]);
  });

  // #238, ADR 0091: the reset is claude's text, shown as plain text like any summary (ADR 0072).
  it('says which usage limit a batch is Stuck on and when it resets, as plain text', () => {
    const summary = 'claude hit its session limit, which resets 3:45pm: retry the step after that';
    const text = renderStatus(
      batch({
        lane: stuck({ kind: 'blocked', stepId: 'brew', blockerKind: 'environment', summary }),
        steps: new Map([step('plan', done(1)), step('brew', failed(1, summary))]),
      }),
      steps,
    );
    assert.ok(text.includes(`\`brew\` is blocked (environment): ${summary}`));
  });

  it('lists the questions of a batch Stuck for input', () => {
    const question = {
      q: 'Which port?',
      options: ['80', '8080'],
      recommended: '8080',
      whyBlocking: 'Both are in use',
    };
    const text = renderStatus(
      batch({ lane: stuck({ kind: 'needs_input', stepId: 'plan', questions: [question] }) }),
      steps,
    );
    assert.match(text, /Which port\?/);
    assert.match(text, /8080/);
  });

  it('renders every reason a batch can be Stuck for', () => {
    const reasons: StuckReason[] = [
      { kind: 'deadline_passed', stepId: 'brew', deadlineAt: at },
      { kind: 'waiting_for_session', stepId: 'brew' },
      { kind: 'stalled', stepId: 'brew', lastProgressAt: at, turnsWithoutProgress: 30 },
      { kind: 'routing', deadlineAt: at },
    ];
    for (const reason of reasons) {
      const text = renderStatus(batch({ lane: stuck(reason) }), steps);
      assert.match(text, /Stuck/, reason.kind);
    }
  });

  it('leaves the reminder out, so a repeated reminder changes nothing', () => {
    const reason: StuckReason = { kind: 'waiting_for_session', stepId: 'brew' };
    assert.equal(
      renderStatus(batch({ lane: stuck(reason, at) }), steps),
      renderStatus(batch({ lane: stuck(reason, '2026-10-20T09:00:00.000Z') }), steps),
    );
  });

  it('says what a Conditioning batch waits for', () => {
    const text = renderStatus(
      batch({
        lane: { kind: 'conditioning', on: { kind: 'merge', pullRequest: pr }, remindAt: at },
      }),
      steps,
    );
    assert.match(text, /Conditioning/);
    assert.ok(text.includes(pr));
  });

  it('lists the pull requests of a batch on tap', () => {
    const text = renderStatus(batch({ lane: { kind: 'on_tap', pullRequests: [pr] } }), steps);
    assert.match(text, /On tap/);
    assert.ok(text.includes(pr));
  });

  it('says what chose the recipe: its label, the router and why, or who', () => {
    const chosen = (recipe: NonNullable<Batch['recipe']>) => renderStatus(batch({ recipe }), steps);
    assert.match(chosen({ name: 'nip', reason: 'label', source: 'label' }), /chosen by its label/);
    assert.match(
      chosen({ name: 'nip', reason: 'a one-line fix', source: 'router' }),
      /chosen by the router: a one-line fix/,
    );
    assert.match(
      chosen({ name: 'nip', reason: 'override', source: 'human', by: 'bob', via: 'terminal' }),
      /chosen by bob \(terminal\)/,
    );
  });

  it('says what a Conditioning batch waits for: a release or a sibling batch', () => {
    const waiting = (on: Extract<Lane, { kind: 'conditioning' }>['on']) =>
      renderStatus(batch({ lane: { kind: 'conditioning', on, remindAt: at } }), steps);
    const release = waiting({
      kind: 'release',
      repo: 'acme/core',
      package: 'core',
      minVersion: '2.4.0',
    });
    assert.match(release, /core 2\.4\.0 or later in acme\/core/);
    assert.match(waiting({ kind: 'sibling', batchId: '8-1' }), /the batch `8-1`/);
  });

  it('marks a step whose latest attempt asked for input, was stopped, or was abandoned', () => {
    const asked: Attempt = {
      phase: 'finished',
      attempt: 1,
      deadlineAt: at,
      outcome: {
        kind: 'needs_input',
        questions: [{ q: 'Which?', options: ['a', 'b'], recommended: 'a', whyBlocking: 'x' }],
      },
    };
    const stopped: Attempt = {
      phase: 'finished',
      attempt: 1,
      deadlineAt: at,
      outcome: { kind: 'cancelled' },
    };
    const abandoned: Attempt = { phase: 'started', attempt: 2, deadlineAt: at, abandoned: true };
    const text = renderStatus(
      batch({
        steps: new Map([step('plan', asked), step('brew', stopped), step('taste', abandoned)]),
      }),
      steps,
    );
    assert.match(lineOf(text, 'plan'), /❓.*asked for input/);
    assert.match(lineOf(text, 'brew'), /⏹️.*attempt 1 stopped/);
    assert.match(lineOf(text, 'taste'), /⏹️.*attempt 2 stopped/);
  });

  it('writes a pull request URL as an autolink of its normalized form, so it mentions no one', () => {
    const odd = 'https://x.example/a @victim **[click](https://evil.example)**';
    const normalized = 'https://x.example/a%20@victim%20**[click](https://evil.example)**';
    const onTap = renderStatus(batch({ lane: { kind: 'on_tap', pullRequests: [odd] } }), steps);
    assert.ok(onTap.includes(`- <${normalized}>`), onTap);
    assert.doesNotMatch(onTap, / @victim/);
    const waiting = renderStatus(
      batch({
        lane: { kind: 'conditioning', on: { kind: 'merge', pullRequest: odd }, remindAt: at },
      }),
      steps,
    );
    assert.ok(waiting.includes(`the merge of <${normalized}>`), waiting);
  });

  it("stays within GitHub's limit for a comment however many questions a brewer asked", () => {
    const long = '@'.repeat(300);
    const question = {
      q: long,
      options: Array(30).fill(long),
      recommended: long,
      whyBlocking: 'x',
    };
    const text = renderStatus(
      batch({
        lane: stuck({ kind: 'needs_input', stepId: 'plan', questions: Array(40).fill(question) }),
      }),
      steps,
    );
    assert.ok(text.length <= 60_000, `${text.length} characters`);
    assert.match(text, /and 30 more questions/);
    assert.match(text, /and 20 more options/);
  });

  it('counts no more questions or options when it shows them all', () => {
    const question = { q: 'Which?', options: ['a', 'b'], recommended: 'a', whyBlocking: 'x' };
    const asked = renderStatus(
      batch({ lane: stuck({ kind: 'needs_input', stepId: 'plan', questions: [question] }) }),
      steps,
    );
    const blocked = renderStatus(
      batch({
        lane: stuck({ kind: 'blocked', stepId: 'plan', blockerKind: 'findings', summary: 'x' }),
      }),
      steps,
    );
    for (const text of [asked, blocked]) assert.doesNotMatch(text, /more (questions|options)/);
  });

  it('escapes every Markdown character a brewer wrote, exactly', () => {
    const text = renderStatus(
      batch({ steps: new Map([step('plan', done(1, ['[a](b) `c` #d |e ~f !g _h']))]) }),
      steps,
    );
    const line = text.split('\n').find((each) => each.startsWith('- `plan`: '));
    assert.equal(line, '- `plan`: \\[a\\](b) \\`c\\` \\#d \\|e \\~f \\!g \\_h');
  });

  it("shows a step's assumptions from its latest attempt that succeeded, though a later one failed", () => {
    const text = renderStatus(
      batch({ steps: new Map([step('plan', done(1, ['Port 8080 is free']), failed(2, 'crash'))]) }),
      steps,
    );
    assert.match(text, /- `plan`: Port 8080 is free/);
  });

  it('cuts a text past 60,000 characters at a line, with a note', () => {
    const many = Array.from({ length: 400 }, (_, i) => `s${i}`);
    const text = renderStatus(
      batch({ steps: new Map(many.map((id) => step(id, failed(1, '@'.repeat(300))))) }),
      many,
    );
    assert.ok(text.length <= 60_000, `${text.length} characters`);
    assert.match(text, /\n\n… the rest is cut: GitHub keeps comments shorter\.$/);
    assert.match(
      text,
      /^- ❌ `s\d+`: attempt 1 failed: (&#64;)+…\n\n…/m,
      'the last line kept is whole',
    );
  });

  it('says so when a batch on tap has no pull request', () => {
    const text = renderStatus(batch({ lane: { kind: 'on_tap', pullRequests: [] } }), steps);
    assert.match(text, /No pull request/);
  });

  it('says the reason of every kind of Stuck on its line', () => {
    const cases: [StuckReason, RegExp][] = [
      [
        { kind: 'attempts_exhausted', stepId: 'brew', attempts: 2, lastReason: 'crash' },
        /`brew` used its 2 attempts; the last: crash/,
      ],
      [
        { kind: 'deadline_passed', stepId: 'brew', deadlineAt: at },
        /`brew` passed its deadline of 2026-10-18T09:00:00\.000Z/,
      ],
      [{ kind: 'waiting_for_session', stepId: 'brew' }, /`brew` waits for its session/],
      [
        { kind: 'stalled', stepId: 'brew', lastProgressAt: at, turnsWithoutProgress: 30 },
        /`brew` stalled: .* since 2026-10-18T09:00:00\.000Z, for 30 turns/,
      ],
      [
        { kind: 'routing', deadlineAt: at },
        /no recipe was chosen by its routing deadline, 2026-10-18T09:00:00\.000Z/,
      ],
      [
        { kind: 'stopped', stepId: 'brew', by: 'ada', via: 'terminal', why: '@bob <b>lunch</b>' },
        /`brew` was stopped by ada \(terminal\): &#64;bob &lt;b&gt;lunch&lt;\/b&gt;$/,
      ],
      [
        { kind: 'stopped', stepId: 'brew', by: 'ada', via: 'plugin' },
        /`brew` was stopped by ada \(plugin\)$/,
      ],
    ];
    for (const [reason, said] of cases) {
      const text = renderStatus(batch({ lane: stuck(reason) }), steps);
      const line = text.split('\n').find((each) => each.includes('**Stuck**')) ?? '';
      assert.match(line, said, reason.kind);
    }
  });

  it('shows what a brewer wrote escaped as GitHub renders it, cut to 200 characters', () => {
    const shown = (assumption: string): string =>
      renderStatus(batch({ steps: new Map([step('plan', done(1, [assumption]))]) }), steps)
        .split('\n')
        .find((line) => line.startsWith('- `plan`: ')) ?? '';
    assert.equal(
      shown('@alice <b>x</b> **bold** a\\b & c'),
      '- `plan`: &#64;alice &lt;b&gt;x&lt;/b&gt; \\*\\*bold\\*\\* a\\\\b &amp; c',
    );
    assert.equal(shown('x'.repeat(400)), `- \`plan\`: ${'x'.repeat(199)}…`);
    assert.equal(shown('x'.repeat(200)), `- \`plan\`: ${'x'.repeat(200)}`);
  });

  it('says who cancelled a cancelled batch', () => {
    const text = renderStatus(
      batch({ lane: { kind: 'cancelled', by: 'bob', via: 'terminal' } }),
      steps,
    );
    assert.match(text, /Cancelled/);
    assert.match(text, /bob/);
  });

  it("shows the assumptions of each step's latest out doc that succeeded", () => {
    const text = renderStatus(
      batch({
        steps: new Map([
          step('plan', done(1, ['old guess']), done(2, ['Port 8080 is free'])),
          step('brew', {
            phase: 'finished',
            attempt: 1,
            deadlineAt: at,
            outcome: { kind: 'succeeded', output: 'no out doc' },
          }),
        ]),
      }),
      steps,
    );
    assert.match(text, /Port 8080 is free/);
    assert.doesNotMatch(text, /old guess/);
  });

  it("lists a step's new tests and regression tests under Tests, at most 10 of each (ADR 0170)", () => {
    const gauged = (tests: string[], regressionTests: string[]): Attempt => ({
      phase: 'finished',
      attempt: 1,
      deadlineAt: at,
      outcome: {
        kind: 'succeeded',
        output: { status: 'done', summary: 'Gauged', assumptions: [], tests, regressionTests },
      },
    });
    const many = Array.from({ length: 12 }, (_, i) => `keeps case ${i + 1}`);
    const text = renderStatus(
      batch({ steps: new Map([step('gauge', gauged(['refuses <npm exec>'], many))]) }),
      ['gauge'],
    );
    const lines = text.split('\n');
    const at_ = lines.indexOf('**Tests**');
    assert.ok(at_ >= 0, text);
    assert.deepEqual(lines.slice(at_ + 1, at_ + 3), [
      '- `gauge`: new test: refuses &lt;npm exec&gt;',
      '- `gauge`: regression test: keeps case 1',
    ]);
    assert.equal(lines[at_ + 11], '- `gauge`: regression test: keeps case 10');
    assert.equal(lines[at_ + 12], '- `gauge`: and 2 more regression tests');
    const newOnes = renderStatus(batch({ steps: new Map([step('gauge', gauged(many, []))]) }), [
      'gauge',
    ]).split('\n');
    const tests = newOnes.indexOf('**Tests**');
    assert.equal(newOnes[tests + 10], '- `gauge`: new test: keeps case 10');
    assert.equal(newOnes[tests + 11], '- `gauge`: and 2 more new tests');
    // One past the cap is counted too, never dropped.
    const eleven = renderStatus(
      batch({ steps: new Map([step('gauge', gauged([], many.slice(0, 11)))]) }),
      ['gauge'],
    );
    assert.match(eleven, /- `gauge`: and 1 more regression tests/);
    // A Gauger sent back names its tests again: its latest success's names are shown.
    const again = renderStatus(
      batch({
        steps: new Map([
          step('gauge', gauged([], ['keeps the old case']), {
            ...gauged([], ['keeps the new case']),
            attempt: 2,
          }),
        ]),
      }),
      ['gauge'],
    );
    assert.match(again, /regression test: keeps the new case/);
    assert.doesNotMatch(again, /keeps the old case/);
    assert.doesNotMatch(
      renderStatus(batch({ steps: new Map([step('plan', done(1))]) }), steps),
      /\*\*Tests\*\*/,
    );
  });

  it("lists a Taster's findings under Findings, by step, saying which were there before (ADR 0161)", () => {
    const finding = (n: number, introduced = true) => ({
      file: 'src/wait.ts',
      line: n,
      severity: 'major',
      why: `finding ${n}`,
      introduced,
    });
    const tasted = (findings: ReturnType<typeof finding>[]): Attempt => ({
      phase: 'finished',
      attempt: 1,
      deadlineAt: at,
      outcome: {
        kind: 'succeeded',
        output: {
          status: 'done',
          summary: 'Tasted',
          assumptions: [],
          // The verdict follows from the findings (ADR 0161).
          verdict: findings.some(({ severity, introduced }) => introduced && severity !== 'minor')
            ? 'changes'
            : 'approve',
          findings,
        },
      },
    });
    const many = Array.from({ length: 12 }, (_, i) => finding(i + 1));
    const text = renderStatus(
      batch({
        steps: new Map([
          step('taste', tasted([{ ...finding(1, false), severity: 'minor' }])),
          step('security', tasted(many)),
        ]),
      }),
      ['taste', 'security'],
    );
    const lines = text.split('\n');
    const at_ = lines.indexOf('**Findings**');
    assert.ok(at_ >= 0, text);
    assert.equal(
      lines[at_ + 1],
      '- `taste`: minor in src/wait.ts:1, there before the change: finding 1',
    );
    assert.equal(lines[at_ + 2], '- `security`: major in src/wait.ts:1: finding 1');
    assert.match(text, /finding 10\b/);
    assert.doesNotMatch(text, /finding 11\b/);
    assert.equal(lines[at_ + 12], '- `security`: and 2 more');
    assert.doesNotMatch(
      renderStatus(batch({ steps: new Map([step('plan', done(1))]) }), steps),
      /Findings/,
    );
  });

  it("lists a Finer's changes under Simplifications, ten per step, or why it changed nothing (ADR 0166)", () => {
    const fined = (fields: Record<string, unknown>): Attempt => ({
      phase: 'finished',
      attempt: 1,
      deadlineAt: at,
      outcome: {
        kind: 'succeeded',
        output: { status: 'done', summary: 'Fined', assumptions: [], ...fields },
      },
    });
    const changes = Array.from({ length: 12 }, (_, i) => ({
      file: 'src/slug.ts',
      line: i + 1,
      why: `change ${i + 1}`,
    }));
    const text = renderStatus(
      batch({
        steps: new Map([
          step('fine', fined({ changes })),
          step('polish', fined({ changes: [], unchanged: `Already small ${token}` })),
        ]),
      }),
      ['fine', 'polish'],
    );
    const lines = text.split('\n');
    const at_ = lines.indexOf('**Simplifications**');
    assert.ok(at_ >= 0, text);
    assert.equal(lines[at_ + 1], '- `fine`: src/slug.ts:1: change 1');
    assert.match(text, /change 10\b/);
    assert.doesNotMatch(text, /change 11\b/);
    assert.equal(lines[at_ + 11], '- `fine`: and 2 more');
    assert.equal(
      lines[at_ + 12],
      '- `polish`: nothing to simplify: \\[left out: a text of step polish that looks like a secret\\]',
    );
    assert.doesNotMatch(
      renderStatus(batch({ steps: new Map([step('plan', done(1))]) }), steps),
      /Simplifications/,
    );
  });

  it("escapes a Finer's change and leaves out one that looks like a secret (review of #462)", () => {
    const output = {
      status: 'done',
      summary: 'Fined',
      assumptions: [],
      changes: [
        { file: 'src/slug_of.ts', line: 3, why: 'Merged *two* copies' },
        { file: 'src/a.ts', why: `Token ${token}` },
      ],
    };
    const fined: Attempt = {
      phase: 'finished',
      attempt: 1,
      deadlineAt: at,
      outcome: { kind: 'succeeded', output },
    };
    const text = renderStatus(batch({ steps: new Map([step('fine', fined)]) }), ['fine']);
    const lines = text.split('\n');
    const at_ = lines.indexOf('**Simplifications**');
    assert.deepEqual(lines.slice(at_ + 1, at_ + 3), [
      '- `fine`: src/slug\\_of.ts:3: Merged \\*two\\* copies',
      '- `fine`: src/a.ts: \\[left out: a text of step fine that looks like a secret\\]',
    ]);
    assert.doesNotMatch(text, /ghp|A1b2/);
  });

  it("shows no Taster's findings from an earlier round when its latest attempt did not succeed (ADR 0161)", () => {
    const approved: Attempt = {
      phase: 'finished',
      attempt: 1,
      deadlineAt: at,
      outcome: {
        kind: 'succeeded',
        output: {
          status: 'done',
          summary: 'Tasted',
          assumptions: [],
          verdict: 'approve',
          findings: [{ severity: 'minor', why: 'an old round', introduced: true }],
        },
      },
    };
    const blocked = failed(2, 'blocked (findings): the Taster asks for changes: x');
    const text = renderStatus(batch({ steps: new Map([step('taste', approved, blocked)]) }), [
      'taste',
    ]);
    assert.doesNotMatch(text, /Findings|an old round/);
  });

  /** A Taster's attempt that approved, with `riskLeft` when it is given. */
  const risky = (attempt: number, riskLeft?: string[]): Attempt => ({
    phase: 'finished',
    attempt,
    deadlineAt: at,
    outcome: {
      kind: 'succeeded',
      output: {
        status: 'done',
        summary: 'Tasted',
        assumptions: [],
        verdict: 'approve',
        findings: [{ severity: 'minor', why: 'a small thing', introduced: true }],
        ...(riskLeft === undefined ? {} : { riskLeft }),
      },
    },
  });

  it("lists each Taster's risk left under Risk left, after its findings, five per step, and none when empty (ADR 0214)", () => {
    const many = Array.from({ length: 7 }, (_, i) => `risk ${i + 1}`);
    const text = renderStatus(
      batch({
        steps: new Map([
          step('correctness', risky(1, ['Only a run shows *the* retry'])),
          step('security', risky(1, many)),
          step('necessity', risky(1)),
        ]),
      }),
      ['correctness', 'security', 'necessity'],
    );
    const lines = text.split('\n');
    const at_ = lines.indexOf('**Risk left**');
    // Right after the three steps' findings, so a comment cut to length keeps it before the rest.
    assert.equal(at_, lines.indexOf('**Findings**') + 5, text);
    assert.deepEqual(lines.slice(at_ + 1, at_ + 8), [
      '- `correctness`: Only a run shows \\*the\\* retry',
      '- `security`: risk 1',
      '- `security`: risk 2',
      '- `security`: risk 3',
      '- `security`: risk 4',
      '- `security`: risk 5',
      '- `security`: and 2 more',
    ]);
    assert.doesNotMatch(text, /`necessity`: risk|risk 6/);
    // None when no Taster wrote one, or only an empty one.
    const none = renderStatus(
      batch({ steps: new Map([step('taste', risky(1)), step('security', risky(1, []))]) }),
      ['taste', 'security'],
    );
    assert.match(none, /\*\*Findings\*\*/);
    assert.doesNotMatch(none, /Risk left/);
  });

  it("shows only the latest round's risk left, and none when that round did not succeed (ADR 0214)", () => {
    const later = renderStatus(
      batch({
        steps: new Map([step('taste', risky(1, ['an old risk']), risky(2, ['a new risk']))]),
      }),
      ['taste'],
    );
    assert.match(later, /- `taste`: a new risk/);
    assert.doesNotMatch(later, /an old risk/);
    const blocked = failed(2, 'blocked (findings): the Taster asks for changes: x');
    const text = renderStatus(
      batch({ steps: new Map([step('taste', risky(1, ['an old risk']), blocked)]) }),
      ['taste'],
    );
    assert.doesNotMatch(text, /Risk left|an old risk/);
  });

  it('shows at most 10 assumptions a step and counts the rest', () => {
    const many = Array.from({ length: 12 }, (_, i) => `guess ${i + 1}`);
    const text = renderStatus(batch({ steps: new Map([step('plan', done(1, many))]) }), steps);
    assert.match(text, /guess 10\b/);
    assert.doesNotMatch(text, /guess 11\b/);
    assert.match(text, /2 more/);
  });

  it('writes what a brewer wrote as one escaped line: no mention, no marker, no Markdown', () => {
    const planted = `@alice see ${effectMarker('["7-1","status.9"]')} **bold**\n# heading ${'x'.repeat(400)}`;
    const text = renderStatus(batch({ steps: new Map([step('plan', done(1, [planted]))]) }), steps);
    assert.doesNotMatch(text, /@alice/);
    assert.doesNotMatch(text, /<!--/);
    assert.doesNotMatch(text, /\*\*bold\*\*/);
    assert.doesNotMatch(text, /^# heading/m);
    const line = text.split('\n').find((each) => each.includes('alice')) ?? '';
    assert.ok(line.includes('heading'), 'the text stays on one line');
    assert.ok(!line.includes('x'.repeat(250)), 'and is cut short');
  });
});

describe('renderStatus: out doc text that looks like a secret (#235)', () => {
  it("keeps a Taster's finding on one line and leaves out one that looks like a secret (ADR 0161)", () => {
    const findings = [
      {
        // A file is one line (the schema), so only `why` can try to start a line of its own.
        file: 'src/a_b.ts',
        severity: 'major',
        why: 'x\n# heading\n**Pull requests**',
        introduced: true,
      },
      { severity: 'major', why: `Token ${token}`, introduced: true },
    ];
    const tasted: Attempt = {
      phase: 'finished',
      attempt: 1,
      deadlineAt: at,
      outcome: {
        kind: 'succeeded',
        output: {
          status: 'done',
          summary: 'Tasted',
          assumptions: [],
          verdict: 'changes',
          findings,
        },
      },
    };
    const text = renderStatus(batch({ steps: new Map([step('taste', tasted)]) }), ['taste']);
    const lines = text.split('\n');
    const at_ = lines.indexOf('**Findings**');
    assert.ok(at_ >= 0, text);
    assert.match(
      lines[at_ + 1] ?? '',
      /^- `taste`: major in src\/a\\_b\.ts: x \\# heading \\\*\\\*Pull requests\\\*\\\*$/,
    );
    assert.match(
      lines[at_ + 2] ?? '',
      new RegExp(`^- \`taste\`: major: ${escaped(leftOut('taste'))}$`),
    );
    assert.doesNotMatch(text, /^# heading|^\*\*Pull requests\*\*/m);
    noToken(text);
  });

  it("leaves out a Taster's risk left that looks like a secret, naming the step (ADR 0214)", () => {
    const tasted: Attempt = {
      phase: 'finished',
      attempt: 1,
      deadlineAt: at,
      outcome: {
        kind: 'succeeded',
        output: {
          status: 'done',
          summary: 'Tasted',
          assumptions: [],
          verdict: 'approve',
          findings: [],
          riskLeft: ['Not run on Windows', `Token ${token}`],
        },
      },
    };
    const text = renderStatus(batch({ steps: new Map([step('taste', tasted)]) }), ['taste']);
    const lines = text.split('\n');
    const at_ = lines.indexOf('**Risk left**');
    assert.ok(at_ >= 0, text);
    assert.equal(lines[at_ + 1], '- `taste`: Not run on Windows');
    assert.match(lines[at_ + 2] ?? '', new RegExp(`^- \`taste\`: ${escaped(leftOut('taste'))}$`));
    noToken(text);
  });

  it('leaves out an assumption, naming the step, and keeps the others', () => {
    const text = renderStatus(
      batch({ steps: new Map([step('plan', done(1, [`Token ${token}`, 'Port 8080 is free']))]) }),
      steps,
    );
    assert.match(
      text,
      new RegExp(`- \`plan\`: ${escaped(leftOut('plan'))}\n- \`plan\`: Port 8080 is free`),
    );
    noToken(text);
  });

  it('reads only the start of a text it can show, so a long one cannot stall the driver', () => {
    const long = `Port 8080 is free.${'\nx'.repeat(500_000)}\n${token}`;
    const text = renderStatus(batch({ steps: new Map([step('plan', done(1, [long]))]) }), steps);
    assert.match(text, /- `plan`: Port 8080 is free\. x x x/);
    noToken(text);
  });

  it('reads past the characters it shows, so a token cut there is still left out', () => {
    const cut = `${'Port 8080 is free. '.repeat(10)}${token}`;
    const text = renderStatus(batch({ steps: new Map([step('plan', done(1, [cut]))]) }), steps);
    assert.match(text, new RegExp(`- \`plan\`: ${escaped(leftOut('plan'))}`));
    noToken(text);
  });

  it("leaves out a blocked step's summary, and a failed attempt's reason", () => {
    const text = renderStatus(
      batch({
        lane: stuck({ kind: 'blocked', stepId: 'brew', blockerKind: 'findings', summary: token }),
        steps: new Map([
          step('plan', failed(1, `the brewer failed: ${token}`), done(2)),
          step('brew', failed(1, `blocked (findings): ${token}`)),
        ]),
      }),
      steps,
    );
    assert.match(text, new RegExp(`is blocked \\(findings\\): ${escaped(leftOut('brew'))}`));
    noToken(text);
  });

  it("leaves out a failed step's reason on its line", () => {
    const text = renderStatus(
      batch({ steps: new Map([step('plan', failed(1, `the brewer failed: ${token}`))]) }),
      steps,
    );
    assert.match(lineOf(text, 'plan'), new RegExp(`failed: ${escaped(leftOut('plan'))}`));
    noToken(text);
  });

  it("leaves out the last reason of a step that used its attempts, and a question's texts", () => {
    const exhausted = renderStatus(
      batch({
        lane: stuck({ kind: 'attempts_exhausted', stepId: 'brew', attempts: 2, lastReason: token }),
      }),
      steps,
    );
    assert.match(exhausted, new RegExp(`the last: ${escaped(leftOut('brew'))}`));
    noToken(exhausted);
    const question = {
      q: `Use ${token}?`,
      options: ['yes', token],
      recommended: token,
      whyBlocking: 'x',
    };
    const asked = renderStatus(
      batch({ lane: stuck({ kind: 'needs_input', stepId: 'plan', questions: [question] }) }),
      steps,
    );
    assert.match(
      asked,
      new RegExp(`- ${escaped(leftOut('plan'))} Options: yes, ${escaped(leftOut('plan'))}`),
    );
    noToken(asked);
  });

  it('keeps a commit hash that `isCommit` knows, as the refused push names its commits', () => {
    const sha = 'c'.repeat(40);
    const reason: StuckReason = {
      kind: 'blocked',
      stepId: 'brew',
      blockerKind: 'environment',
      summary: `the push stopped: commit ${sha}, GitHub token in notes.txt`,
    };
    const known = renderStatus(batch({ lane: stuck(reason) }), steps, (word) => word === sha);
    assert.match(known, new RegExp(`commit ${sha}, GitHub token in notes.txt`));
    const unknown = renderStatus(batch({ lane: stuck(reason) }), steps);
    assert.doesNotMatch(unknown, new RegExp(sha));
  });
});

/** A fake of the comments host: the comments of every issue, ids from 1, as `login` sees them. */
const fakeComments = (login: string) => {
  const comments: { id: number; repo: string; issue: number; author: string; body: string }[] = [];
  const calls: string[] = [];
  let ids = 0;
  const byId = (repo: string, id: number) =>
    comments.find((comment) => comment.repo === repo && comment.id === id);
  const host: StatusComments = {
    find: async (repo, issue, marker) => {
      calls.push('find');
      const found = comments.find(
        (comment) =>
          comment.repo === repo &&
          comment.issue === issue &&
          comment.author === login &&
          comment.body.endsWith(marker),
      );
      return found === undefined ? undefined : { id: found.id, body: found.body };
    },
    read: async (repo, id) => {
      calls.push('read');
      const found = byId(repo, id);
      return found?.author === login ? found.body : undefined;
    },
    create: async (repo, issue, body) => {
      calls.push('create');
      ids += 1;
      comments.push({ id: ids, repo, issue, author: login, body });
      return ids;
    },
    edit: async (repo, id, body) => {
      calls.push('edit');
      const found = byId(repo, id);
      if (found === undefined) return 'gone';
      found.body = body;
      return 'edited';
    },
  };
  /** Someone else comments, or a run that was killed did; ids go on from the fake's. */
  const add = (author: string, body: string, issue = 7): number => {
    ids += 1;
    comments.push({ id: ids, repo: brewery, issue, author, body });
    return ids;
  };
  return { host, comments, calls, add };
};

const brewery = 'alice/brewery';
const minute = 60_000;
const succeeded: Ending = {
  kind: 'succeeded',
  output: { status: 'done', summary: 'Done', assumptions: ['Port 8080 is free'] },
};
const digest = (text: string): string =>
  createHash('sha256').update(text).digest('hex').slice(0, 16);
const marker = (revision: number): string =>
  effectMarker(effectKey.encode({ batchId: '7-1', effect: `status.${revision}` }));

describe('statusEffects', () => {
  const recipes = fakeRecipes({ nip: fakeRecipe({ steps: ['plan', 'brew'], pullRequests: [pr] }) });
  let store: EventStore;
  let log: CommandLog;
  let comments: ReturnType<typeof fakeComments>;
  let now: Date;
  let notices: DriverNotice[];
  const drivers: Driver[] = [];

  beforeEach(() => {
    store = openSqliteEventStore(':memory:');
    log = createCommandLog({ store, recipes });
    comments = fakeComments('alice');
    now = new Date(at);
    notices = [];
  });
  afterEach(() => {
    for (const driver of drivers.splice(0)) driver.close();
    store.close();
  });

  const open = async (): Promise<Driver> => {
    const driver = await openDriver({
      store,
      runner: { start: () => assert.fail('no attempt starts'), progress: () => undefined },
      recipes,
      clock: () => now,
      lock: () => fakeLock('cellar'),
      takes: () => true,
      stateBranch: { flush: async () => ({ kind: 'unchanged' }) },
      limits: () => defaultLimits,
      effects: statusEffects({ brewery, comments: comments.host, recipes, clock: () => now }),
      report: (notice) => notices.push(notice),
    });
    drivers.push(driver);
    return driver;
  };
  const issue = (command: Parameters<CommandLog['issue']>[0]): void => {
    const decision = log.issue(command, now);
    assert.equal(decision.kind, 'accepted', JSON.stringify(decision));
  };
  const order = (): void => issue({ kind: 'order', batchId: '7-1', order: { issue: 7 } });
  /** Routes 7-1 to nip and starts its first step, as another driver would. */
  const brew = (): void => {
    issue({ kind: 'route', batchId: '7-1', recipe: 'nip', reason: 'label', source: 'label' });
    issue({
      kind: 'record',
      event: { type: 'step.started', batchId: '7-1', stepId: 'plan', attempt: 1 },
    });
  };
  /** Finishes both steps of 7-1, so it goes on tap. */
  const finish = (): void => {
    issue({ kind: 'finish', batchId: '7-1', stepId: 'plan', attempt: 1, ending: succeeded });
    const brewing = { batchId: '7-1', stepId: 'brew', attempt: 1 };
    issue({ kind: 'record', event: { type: 'step.started', ...brewing } });
    issue({ kind: 'finish', ...brewing, ending: succeeded });
  };
  const later = (ms: number): void => {
    now = new Date(now.getTime() + ms);
  };
  const revision = (n: number) => store.findEffect({ batchId: '7-1', effect: `status.${n}` });
  const only = () => {
    assert.equal(comments.comments.length, 1, 'one status comment');
    return comments.comments[0] ?? assert.fail();
  };

  it("comments on the order's issue in the Brewery's repository at once, ending with its revision's marker", async () => {
    order();
    const driver = await open();
    await driver.tick();
    const comment = only();
    assert.equal(comment.repo, brewery);
    assert.equal(comment.issue, 7);
    assert.match(comment.body, /Ordered/);
    assert.ok(comment.body.endsWith(marker(1)), comment.body);
    assert.deepEqual(notices, []);
  });

  it('records each revision: the comment, and the digest of the text it shows', async () => {
    order();
    const driver = await open();
    await driver.tick();
    const text = only().body.slice(0, -marker(1).length).trimEnd();
    assert.deepEqual(revision(1), { result: { comment: 1, digest: digest(text) } });
  });

  it('edits the same comment as the batch moves, at most once a minute', async () => {
    order();
    const driver = await open();
    await driver.tick();
    brew();
    await driver.tick();
    later(minute - 1);
    await driver.tick();
    assert.match(only().body, /Ordered/, 'not edited within the minute');
    assert.equal(revision(2), undefined);
    later(1);
    await driver.tick();
    assert.match(only().body, /Brewing/);
    assert.match(only().body, /`plan`/);
    assert.ok(only().body.endsWith(marker(2)));
    assert.equal(comments.calls.filter((call) => call === 'create').length, 1);
  });

  it('shows the batch on tap at once, with its pull request, and lets the batch go', async () => {
    order();
    const driver = await open();
    await driver.tick();
    brew();
    finish();
    await driver.tick();
    assert.match(only().body, /On tap/);
    assert.ok(only().body.includes(pr));
    assert.match(only().body, /Port 8080 is free/);
    assert.deepEqual(driver.held(), []);
    assert.deepEqual(notices, []);
  });

  it('edits the comment to say Paused when its order is paused, and again when it continues (ADR 0202)', async () => {
    order();
    const driver = await open();
    await driver.tick();
    brew();
    later(minute);
    await driver.tick();
    issue({ kind: 'pause', order: { issue: 7 }, by: 'ada', via: 'terminal', why: 'lunch' });
    later(minute);
    await driver.tick();
    assert.match(only().body, /Paused\*\* by ada \(terminal\): lunch\./);
    issue({ kind: 'continue', order: { issue: 7 }, by: 'ada', via: 'terminal' });
    later(minute);
    await driver.tick();
    assert.doesNotMatch(only().body, /Paused/);
  });

  it('edits the comment of a brewing batch to say the usage window is closed (ADR 0206)', async () => {
    order();
    const driver = await open();
    await driver.tick();
    brew();
    issue({
      kind: 'finish',
      batchId: '7-1',
      stepId: 'plan',
      attempt: 1,
      ending: {
        kind: 'blocked',
        blockerKind: 'environment',
        summary: 'claude hit its session limit, which resets 3:45pm',
        usageLimit: { limit: 'session', resets: '3:45pm' },
      },
      reopensAt: { at: new Date('2026-10-18T14:50:00.000Z'), read: true },
    });
    later(minute);
    // The retry of plan waits for the reopen: the runner starts nothing.
    await driver.tick();
    assert.match(
      only().body,
      /Usage window closed: claude hit its session limit, which resets 3:45pm; brewers wait until 14:50 UTC, 18 October\./,
    );
  });

  it('edits nothing while the text stays the same', async () => {
    order();
    const driver = await open();
    await driver.tick();
    const calls = [...comments.calls];
    later(5 * minute);
    await driver.tick();
    await driver.tick();
    assert.deepEqual(comments.calls, calls);
    assert.equal(revision(2), undefined);
  });

  it('makes the comment again at the next edit when it was deleted by hand', async () => {
    order();
    const driver = await open();
    await driver.tick();
    comments.comments.splice(0);
    brew();
    later(minute);
    await driver.tick();
    const comment = only();
    assert.equal(comment.id, 2);
    assert.match(comment.body, /Brewing/);
    assert.deepEqual(revision(2)?.result, {
      comment: 2,
      digest: digest(comment.body.slice(0, -marker(2).length).trimEnd()),
    });
    finish();
    await driver.tick();
    assert.match(only().body, /On tap/, 'the next revision edits the new comment');
  });

  it('finds a comment a run before made again for a deleted one, by its marker, and makes no other', async () => {
    order();
    const driver = await open();
    await driver.tick();
    // Revision 1's comment was deleted by hand; a run that was killed made revision 2's again.
    comments.comments.splice(0);
    const id = comments.add('alice', `Earlier\n\n${marker(2)}`);
    brew();
    later(minute);
    await driver.tick();
    assert.equal(comments.calls.filter((call) => call === 'create').length, 1);
    assert.deepEqual(revision(2), { result: { comment: id, digest: digest('Earlier') } });
  });

  it('finds a first comment a run before made and was killed before it recorded', async () => {
    order();
    comments.add('alice', `Earlier\n\n${marker(1)}`);
    const driver = await open();
    await driver.tick();
    assert.equal(comments.calls.includes('create'), false);
    assert.deepEqual(revision(1), { result: { comment: 1, digest: digest('Earlier') } });
    later(minute);
    await driver.tick();
    assert.match(only().body, /Ordered/, 'its stale text is replaced');
  });

  it('finds an edit a run before made, and records the digest of what the comment shows', async () => {
    order();
    const driver = await open();
    await driver.tick();
    brew();
    // A run that was killed had edited the comment to revision 2 and recorded nothing.
    const comment = only();
    comment.body = `Earlier\n\n${marker(2)}`;
    later(minute);
    await driver.tick();
    assert.deepEqual(revision(2), { result: { comment: 1, digest: digest('Earlier') } });
    later(minute);
    await driver.tick();
    assert.match(only().body, /Brewing/);
    assert.ok(only().body.endsWith(marker(3)));
  });

  it('counts only its own comment, not one someone else planted with the marker', async () => {
    order();
    comments.add('mallory', `Planted\n\n${marker(1)}`);
    const driver = await open();
    await driver.tick();
    assert.equal(comments.comments.length, 2);
    assert.equal(comments.comments[1]?.author, 'alice');
    assert.deepEqual(revision(1)?.result, {
      comment: 2,
      digest: digest(comments.comments[1]?.body.slice(0, -marker(1).length).trimEnd() ?? ''),
    });
  });

  it('records nothing when the code host answers a comment id that is no positive integer', async () => {
    order();
    comments.host.create = async () => 0;
    const driver = await open();
    await driver.tick();
    assert.equal(revision(1), undefined);
    assert.equal(notices[0]?.kind, 'effect_failed');
    assert.match(
      notices[0]?.kind === 'effect_failed' ? String(notices[0].error) : '',
      /comment id that is no positive integer: 0/,
    );
  });

  it('shows a cancelled batch at once, within the minute, and lets the batch go', async () => {
    order();
    const driver = await open();
    await driver.tick();
    issue({ kind: 'cancel', batchId: '7-1', by: 'bob', via: 'terminal' });
    await driver.tick();
    assert.match(only().body, /Cancelled/);
    assert.deepEqual(driver.held(), []);
  });

  it("lists the recipe's steps the batch has not reached yet", async () => {
    order();
    const driver = await open();
    await driver.tick();
    brew();
    later(minute);
    await driver.tick();
    assert.match(lineOf(only().body, 'brew'), /⬜/);
  });

  it('counts the minute from a revision it found on the code host too', async () => {
    order();
    const driver = await open();
    await driver.tick();
    brew();
    // A run that was killed had edited the comment to revision 2 and recorded nothing.
    only().body = `Earlier\n\n${marker(2)}`;
    later(minute);
    await driver.tick();
    assert.notEqual(revision(2), undefined);
    later(minute - 1);
    await driver.tick();
    assert.equal(revision(3), undefined, 'not within a minute of the revision it found');
    later(1);
    await driver.tick();
    assert.ok(only().body.endsWith(marker(3)));
  });

  it("comments on a claimed batch's Brewery issue once the batch records it, and nothing before (ADR 0144)", async () => {
    issue({ kind: 'order', batchId: 'web-7', order: { issue: 7, repo: 'alice/web' } });
    const driver = await open();
    await driver.tick();
    assert.deepEqual(comments.calls, [], 'no Brewery issue yet');
    store.withTransaction((tx) => tx.recordEffect({ batchId: 'web-7', effect: 'order.issue' }, 20));
    await driver.tick();
    issue({ kind: 'route', batchId: 'web-7', recipe: 'nip', reason: 'label', source: 'label' });
    issue({
      kind: 'record',
      event: { type: 'step.started', batchId: 'web-7', stepId: 'plan', attempt: 1 },
    });
    later(minute);
    await driver.tick();
    // One comment, on the Brewery issue #20: never on the Brewery's #7 or the target issue.
    const comment = only();
    assert.deepEqual([comment.repo, comment.issue], [brewery, 20]);
    assert.match(comment.body, /Brewing/);
    assert.ok(
      comment.body.endsWith(
        effectMarker(effectKey.encode({ batchId: 'web-7', effect: 'status.2' })),
      ),
      comment.body,
    );
    assert.deepEqual(notices, []);
  });

  describe('a claimed issue ordered again (ADR 0144)', () => {
    const order = { issue: 7, repo: 'alice/web' };
    const routeBy = '2026-10-23T10:00:00.000Z';
    const applied = (batchId: string, effect: string, result: unknown): void =>
      store.withTransaction((tx) => tx.recordEffect({ batchId, effect }, result));
    /** web-7 opened the Brewery issue #20 and was cancelled; web-7-2 orders the issue again. */
    const again = (): void => {
      issue({ kind: 'order', batchId: 'web-7', order });
      applied('web-7', 'order.issue', 20);
      issue({ kind: 'cancel', batchId: 'web-7', by: 'alice', via: 'terminal' });
      store.withTransaction((tx) =>
        tx.append({ type: 'batch.ordered', batchId: 'web-7-2', order, routeBy }),
      );
    };
    const onIssue = (n: number) => comments.comments.filter((comment) => comment.issue === n);
    const firstOf = (batchId: string) =>
      effectMarker(effectKey.encode({ batchId, effect: 'status.1' }));

    it('gives the new batch a status comment of its own on the Brewery issue it shares', async () => {
      again();
      const driver = await open();
      await driver.tick();
      assert.ok(onIssue(20).some(({ body }) => body.endsWith(firstOf('web-7-2'))));
      assert.deepEqual(onIssue(7), []);
    });

    it('comments nothing for the new batch whose reopen found the Brewery issue gone, until it opens its own', async () => {
      again();
      applied('web-7-2', 'order.reopen', 'gone');
      const driver = await open();
      await driver.tick();
      assert.equal(store.findEffect({ batchId: 'web-7-2', effect: 'status.1' }), undefined);
      applied('web-7-2', 'order.issue', 21);
      await driver.tick();
      assert.ok(onIssue(21).some(({ body }) => body.endsWith(firstOf('web-7-2'))));
      assert.ok(onIssue(20).every(({ body }) => !body.endsWith(firstOf('web-7-2'))));
    });
  });

  it("shows a commit hash the batch's state records, and leaves out a token (#235)", async () => {
    const sha = 'a'.repeat(40);
    order();
    brew();
    const output = { status: 'done', summary: 'Done', assumptions: [`Token ${token}`] };
    issue({
      kind: 'finish',
      batchId: '7-1',
      stepId: 'plan',
      attempt: 1,
      ending: { kind: 'succeeded', output },
    });
    const brewing = { batchId: '7-1', stepId: 'brew', attempt: 1 };
    const worktree = { repo: 'alice/web', path: '/work/brew/1', branch: 'foedrum/brew/1' };
    issue({
      kind: 'record',
      event: { type: 'step.started', ...brewing, worktree: { ...worktree, commit: sha } },
    });
    const summary = `the brewer made no commit since ${sha}`;
    issue({
      kind: 'finish',
      ...brewing,
      ending: { kind: 'blocked', blockerKind: 'divergence', summary },
    });
    const driver = await open();
    await driver.tick();
    const { body } = only();
    assert.match(body, new RegExp(summary));
    assert.match(body, /- `plan`: \\\[left out: a text of step plan that looks like a secret\\\]/);
    assert.doesNotMatch(body, /ghp|A1b2/);
  });
});

describe('renderStatus: the sensitive paths the change touches (ADR 0201)', () => {
  const onTap = batch({ lane: { kind: 'on_tap', pullRequests: [pr] } });
  const sensitiveLine = (text: string): string | undefined =>
    text.split('\n').find((line) => line.startsWith('Touches sensitive paths'));

  it('names them in one line after the steps, before the sections that grow with the out docs', () => {
    const withAssumptions = batch({
      lane: { kind: 'on_tap', pullRequests: [pr] },
      steps: new Map([step('plan', done(1, ['Kept the flag']))]),
    });
    const text = renderStatus(withAssumptions, steps, undefined, undefined, {
      count: 2,
      files: ['src/auth/login.ts', '.github/workflows/ci.yml'],
    });
    assert.equal(
      sensitiveLine(text),
      'Touches sensitive paths: src/auth/login.ts, .github/workflows/ci.yml',
    );
    const at = text.indexOf('Touches sensitive paths');
    assert.ok(lineOf(text, 'taste') !== '' && text.indexOf(lineOf(text, 'taste')) < at, text);
    assert.ok(at < text.indexOf('**Assumptions**'), text);
  });

  it('keeps the line when the comment is cut to the length GitHub takes (review of #523)', () => {
    const long = Array.from({ length: 10 }, (_, n) => `${n} ${'*'.repeat(300)}`);
    const many = Array.from({ length: 40 }, (_, n) => step(`s${n}`, done(1, long)));
    const text = renderStatus(
      batch({ lane: { kind: 'on_tap', pullRequests: [pr] }, steps: new Map(many) }),
      undefined,
      undefined,
      undefined,
      { count: 1, files: ['.github/workflows/ci.yml'] },
    );
    assert.match(text, /the rest is cut/);
    assert.equal(sensitiveLine(text), 'Touches sensitive paths: .github/workflows/ci.yml');
  });

  it('shows nothing when none was recorded', () => {
    assert.equal(sensitiveLine(renderStatus(onTap, steps)), undefined);
    assert.doesNotMatch(renderStatus(onTap, steps), /sensitive/i);
  });

  it('names the first ten and counts the rest, the ones the ledger left out too', () => {
    const files = Array.from({ length: 50 }, (_, n) => `src/auth/f${n}.ts`);
    const line = sensitiveLine(
      renderStatus(onTap, steps, undefined, undefined, { count: 60, files }),
    );
    assert.equal(line, `Touches sensitive paths: ${files.slice(0, 10).join(', ')} and 50 more`);
  });

  it('escapes each file name to one plain line, cut as other texts', () => {
    const long = `src/auth/${'a'.repeat(300)}.ts`;
    const line =
      sensitiveLine(
        renderStatus(onTap, steps, undefined, undefined, {
          count: 2,
          files: ['src/auth/<b>@alice_*x*.ts', long],
        }),
      ) ?? assert.fail('no line');
    assert.ok(line.includes('src/auth/&lt;b&gt;&#64;alice\\_\\*x\\*.ts, '), line);
    assert.doesNotMatch(line, /a{300}/);
    assert.match(line, /a…$/);
  });
});

describe('statusEffects: the sensitive paths the push recorded (ADR 0201)', () => {
  const recipes = fakeRecipes({ nip: fakeRecipe({ steps: ['plan'] }) });
  let store: EventStore;
  let comments: ReturnType<typeof fakeComments>;

  beforeEach(() => {
    store = openSqliteEventStore(':memory:');
    comments = fakeComments('alice');
  });
  afterEach(() => store.close());

  const commented = async (pushed: unknown): Promise<string> => {
    const now = new Date(at);
    const log = createCommandLog({ store, recipes });
    const decision = log.issue({ kind: 'order', batchId: '7-1', order: { issue: 7 } }, now);
    assert.equal(decision.kind, 'accepted');
    store.withTransaction((tx) => tx.recordEffect({ batchId: '7-1', effect: 'push' }, pushed));
    const driver = await openDriver({
      store,
      runner: { start: () => assert.fail('no attempt starts'), progress: () => undefined },
      recipes,
      clock: () => now,
      lock: () => fakeLock('cellar'),
      takes: () => true,
      stateBranch: { flush: async () => ({ kind: 'unchanged' }) },
      limits: () => defaultLimits,
      effects: statusEffects({ brewery, comments: comments.host, recipes, clock: () => now }),
      report: () => undefined,
    });
    try {
      await driver.tick();
    } finally {
      driver.close();
    }
    return comments.comments[0]?.body ?? assert.fail('no status comment');
  };
  const pushed = {
    branch: 'foedrum/acme.brewery/7-1/acme.web',
    commit: 'c'.repeat(40),
    from: 'refs/heads/foedrum/7-1/brew/1',
  };

  it('shows the files the push of the batch recorded', async () => {
    const body = await commented({
      ...pushed,
      sensitive: { count: 1, files: ['.github/workflows/ci.yml'] },
    });
    assert.match(body, /^Touches sensitive paths: \.github\/workflows\/ci\.yml$/m);
  });

  it('shows nothing for a push that recorded none', async () => {
    assert.doesNotMatch(await commented(pushed), /sensitive/i);
  });
});
