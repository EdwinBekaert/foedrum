import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DIAGNOSIS } from '../../scripts/demo/core.ts';
import {
  commentMarkdown,
  diagnosisLines,
  headingOf,
  LOST_LINE,
  laterRoundLines,
  lostAttemptLine,
  PAUSE_PROMPT,
  pausesBetweenSteps,
  RESUMED,
  replayLines,
  routeLines,
  STEPS,
  splitOutput,
  stepLines,
} from '../../scripts/demo/walkthrough.ts';
import { formatReplay } from '../../src/cli/replay.ts';
import type { StoredEvent } from '../../src/engine/event-store.ts';
import type { Batch } from '../../src/engine/fold.ts';
import type { Event } from '../../src/schemas/events.ts';

describe('the walkthrough steps', () => {
  it('go from the diagnosis to the mash, in the order a batch lives them, with the lenses, brew, resume and replay after on tap', () => {
    assert.deepStrictEqual(
      STEPS.map(({ id }) => id),
      [
        'diagnosis',
        'order',
        'brewing',
        'restart',
        'checks',
        'pull-request',
        'on-tap',
        'lenses',
        'brew',
        'resume',
        'replay',
        'mash',
      ],
    );
  });

  it('end with a mash of the third order', () => {
    assert.equal(STEPS.find((step) => step.id === 'mash')?.title, 'foedrum mash 3 --as ann');
  });

  it("name the commands of brew and resume, the latter with the Cellarman's second attempt", () => {
    const title = (id: string) => STEPS.find((step) => step.id === id)?.title;
    assert.equal(title('lenses'), 'foedrum lenses');
    assert.equal(title('brew'), 'foedrum brew 2 --as ann');
    assert.equal(title('resume'), `foedrum resume 1-1 ${RESUMED}`);
    assert.equal(RESUMED, 'implement#2');
  });

  it('each have a heading and what to look for', () => {
    assert.ok(STEPS.length > 0);
    for (const step of STEPS) {
      assert.ok(step.title.trim() !== '', step.id);
      assert.ok(step.lookFor.trim() !== '', step.id);
      assert.ok(!step.lookFor.includes('\n'), step.id);
    }
  });

  it('are numbered in their headings, each heading its own', () => {
    assert.equal(headingOf(2), `Step 3 of 12: ${STEPS[2]?.title}`);
    assert.equal(new Set(STEPS.map((_, index) => headingOf(index))).size, STEPS.length);
  });

  it('open with a blank line, the heading and what to look for', () => {
    const [blank, heading, ...lookFor] = stepLines(0);
    assert.equal(blank, '');
    assert.equal(heading, headingOf(0));
    assert.equal(lookFor.map((line) => line.trim()).join(' '), `Look for: ${STEPS[0]?.lookFor}`);
  });

  it('say what to look for in at most two lines of at most 80 characters (#662)', () => {
    for (const [index, { id }] of STEPS.entries()) {
      const lookFor = stepLines(index).slice(2);
      assert.ok(lookFor.length <= 2, `${id}: ${lookFor.join(' / ')}`);
      for (const line of lookFor) assert.ok(line.length <= 80, `${id}: ${line}`);
    }
  });

  it('wrap what to look for under its label (regression test)', () => {
    const wrapped = STEPS.flatMap((_, index) => stepLines(index).slice(3));
    assert.ok(wrapped.length > 0);
    for (const line of wrapped) assert.match(line, /^ {10}\S/);
  });

  it("say where the parallel group and the tasting loop show: three lenses at once, the batch sent back twice, the comment's path a line per round", () => {
    const lookFor = (id: string) => STEPS.find((step) => step.id === id)?.lookFor ?? '';
    assert.match(lookFor('order'), /recipe:nip-parallel/);
    assert.match(lookFor('order'), /three lenses at once/);
    assert.match(lookFor('checks'), /implement #2 is told why/);
    assert.match(lookFor('checks'), /correctness #1 blocks/);
    assert.match(lookFor('pull-request'), /a line per round/);
  });

  it('say that the diagnosis is the demo own, not doctor on this machine', () => {
    assert.match(STEPS[0]?.lookFor ?? '', /demo's own/);
    assert.match(STEPS[0]?.lookFor ?? '', /not foedrum doctor/);
  });
});

describe('pausesBetweenSteps', () => {
  it('pauses on a terminal', () => {
    assert.equal(pausesBetweenSteps({ noPause: false, interactive: true }), true);
  });

  it('does not pause with --no-pause, or when no one can press Enter', () => {
    assert.equal(pausesBetweenSteps({ noPause: true, interactive: true }), false);
    assert.equal(pausesBetweenSteps({ noPause: false, interactive: false }), false);
    assert.equal(pausesBetweenSteps({ noPause: true, interactive: false }), false);
  });

  it('stops pausing once the input has ended', () => {
    assert.equal(
      pausesBetweenSteps({ noPause: false, interactive: true, inputEnded: true }),
      false,
    );
  });

  it('asks for Enter, and says how to go without the pauses', () => {
    assert.match(PAUSE_PROMPT, /Enter/);
    assert.match(PAUSE_PROMPT, /--no-pause/);
  });
});

describe('diagnosisLines', () => {
  it('names the brewer the demo runs instead of claude, the isolation and no problems', () => {
    const lines = diagnosisLines(DIAGNOSIS).join('\n');
    assert.match(lines, /claude +the demo brewer, never started/);
    assert.match(lines, /isolation +permissions only: the demo brewer is scripted/);
    assert.match(lines, /problems +none/);
  });

  it('lists the problems when there are any', () => {
    const problems = [
      { required: true, what: 'git is missing', fix: 'install git' },
      { required: false, what: 'no sandbox', fix: 'install bubblewrap' },
    ];
    const lines = diagnosisLines({ ...DIAGNOSIS, problems });
    assert.ok(lines.some((line) => /problems +git is missing: install git$/.test(line)));
    assert.ok(lines.some((line) => /^ +no sandbox: install bubblewrap$/.test(line)));
  });
});

describe('commentMarkdown', () => {
  it('drops the hidden revision marker and the blank lines it leaves at the end', () => {
    const body =
      '### Foedrum · batch `1-1`\n\n🍻 **On tap**\n\n<!-- foedrum:["1-1","status.3"] -->\n';
    assert.equal(commentMarkdown(body), '### Foedrum · batch `1-1`\n\n🍻 **On tap**');
  });

  it('drops every HTML comment, also one across lines, and keeps the rest as it is', () => {
    assert.equal(
      commentMarkdown('a <!-- one --> b\n<!--\ntwo\n-->\nc <!-- three -->'),
      'a  b\n\nc',
    );
  });

  it('leaves a comment without HTML comments alone', () => {
    assert.equal(
      commentMarkdown('- ✅ `brew`\n- ✅ `open-pull-request`'),
      '- ✅ `brew`\n- ✅ `open-pull-request`',
    );
  });
});

describe('lostAttemptLine', () => {
  const ref = { batchId: '1-1', stepId: 'brew' };
  const started = (attempt: number) => ({ type: 'step.started', ...ref, attempt });
  const lost = {
    type: 'step.finished',
    ...ref,
    attempt: 1,
    outcome: {
      kind: 'failed',
      retryable: true,
      reason: 'the attempt was lost: its lease expired',
    },
  };
  const of = (...events: object[]) =>
    lostAttemptLine(events.map((event) => ({ event: event as Event })));

  it('says which attempt was lost, why, and which one brews it again', () => {
    assert.equal(
      of(started(1), lost, started(2)),
      `${LOST_LINE} brew #1 lost (the attempt was lost: its lease expired); brew #2 brews it again`,
    );
  });

  it('says nothing until the next attempt has started', () => {
    assert.equal(of(started(1)), undefined);
    assert.equal(of(started(1), lost), undefined);
  });

  it('says nothing when another step or batch, or a later attempt, starts', () => {
    assert.equal(of(started(1), lost, { ...started(2), stepId: 'open-pull-request' }), undefined);
    assert.equal(of(started(1), lost, { ...started(2), batchId: '1-2' }), undefined);
    assert.equal(of(started(1), lost, started(3)), undefined);
  });

  it('says nothing of an attempt that failed some other way', () => {
    const failed = { ...lost, outcome: { kind: 'failed', retryable: true, reason: 'no commit' } };
    assert.equal(of(started(1), failed, started(2)), undefined);
  });
});

describe('routeLines', () => {
  const ref = { stepId: 'implement', attempt: 2 };
  const prompt = [
    'Make the tests pass.',
    '<untrusted-input-abc name="route" source="why step implement runs again: the failed checks of step green">',
    'Step green ended: the check "test" failed with exit code 1',
    'ok 1 - greets a visitor by name',
    'not ok 2 - greets a stranger when no name is given',
    '    not ok 1 - a nested subtest',
    'the order says not ok 4 - only in passing',
    '</untrusted-input-abc>',
  ].join('\r\n');

  it("says why the attempt runs again and each failed test's own line, nested ones too, from its prompt", () => {
    assert.deepStrictEqual(routeLines(ref, prompt), [
      'demo: implement #2 is told why step implement runs again: the failed checks of step green',
      '  not ok 2 - greets a stranger when no name is given',
      '  not ok 1 - a nested subtest',
    ]);
  });

  it('says nothing for an attempt no route scheduled', () => {
    assert.deepStrictEqual(routeLines(ref, 'Make the tests pass.\nnot ok 2 - a test'), []);
  });
});

describe('laterRoundLines', () => {
  const ref = { stepId: 'correctness', attempt: 2 };
  const prompt = [
    'Taste the change.',
    '<untrusted-input-abc source="the change since commit 0123abc">',
    'diff --git a/greet.mjs b/greet.mjs',
    '</untrusted-input-abc>',
    '<untrusted-input-abc source="the change since commit 4567def" name="roundChange">',
    'diff --git a/greet.mjs b/greet.mjs',
    '</untrusted-input-abc>',
    '<untrusted-input-abc source="the earlier rounds&#39; findings of step correctness, with what was done with them" name="earlierFindings">',
    'Round correctness#1:',
    '- major in greet.mjs:2: a name of only spaces is greeted as itself',
    '  fixed: greet trims the name',
    '</untrusted-input-abc>',
  ].join('\r\n');

  it("says what a later round reviews and lists the earlier rounds' findings with what was done with them, from its prompt", () => {
    assert.deepStrictEqual(laterRoundLines(ref, prompt), [
      'demo: correctness #2 is told the change since commit 4567def, as {roundChange}, and the earlier findings, as {earlierFindings}:',
      '  Round correctness#1:',
      '  - major in greet.mjs:2: a name of only spaces is greeted as itself',
      '    fixed: greet trims the name',
    ]);
  });

  it('says only what a later round reviews when its prompt has no earlier findings', () => {
    const changeOnly = prompt.split('\r\n').slice(0, 7).join('\n');
    assert.deepStrictEqual(laterRoundLines(ref, changeOnly), [
      'demo: correctness #2 is told the change since commit 4567def, as {roundChange}',
    ]);
  });

  it('lists the earlier findings to the end of the prompt when their input is not closed', () => {
    const unclosed = prompt.split('\r\n').slice(0, -1).join('\n');
    assert.deepStrictEqual(laterRoundLines(ref, unclosed).slice(-1), [
      '    fixed: greet trims the name',
    ]);
  });

  it('reads only a whole opening tag: one with more text after it is no input of its name', () => {
    const trailing = prompt.replace('name="roundChange">', 'name="roundChange"> and more');
    assert.deepStrictEqual(laterRoundLines(ref, trailing), []);
    const leading = prompt.replace(
      '<untrusted-input-abc source="the change since commit 4567def"',
      'x <untrusted-input-abc source="the change since commit 4567def"',
    );
    assert.deepStrictEqual(laterRoundLines(ref, leading), []);
  });

  it('says nothing for a first round', () => {
    const first = prompt.split('\r\n').slice(0, 4).join('\n');
    assert.deepStrictEqual(laterRoundLines(ref, first), []);
  });
});

describe('splitOutput', () => {
  const output = 'one\r\ntwo\nmark\nthree\n';
  const mark = (line: string) => line === 'mark';

  it('splits before the first line that matches', () => {
    assert.deepStrictEqual(splitOutput(output, mark, 'before'), [
      ['one', 'two'],
      ['mark', 'three'],
    ]);
  });

  it('keeps the matching line with the first part, when asked', () => {
    assert.deepStrictEqual(splitOutput(output, mark, 'with'), [['one', 'two', 'mark'], ['three']]);
  });

  it('gives all of it as the first part when no line matches, and nothing for no output', () => {
    assert.deepStrictEqual(
      splitOutput(output, () => false, 'before'),
      [['one', 'two', 'mark', 'three'], []],
    );
    assert.deepStrictEqual(splitOutput('', mark, 'before'), [[], []]);
  });
});

describe('replayLines (#662)', () => {
  const output = [
    'Batch 1-1, issue #1',
    '',
    'Events',
    '   1  batch.ordered  {"order":{"issue":1}}',
    '   2  batch.on_tap   {"pullRequests":["https://github.com/demo/web/pull/2"]}',
    '',
    'State',
    '  lane    on tap: https://github.com/demo/web/pull/2',
    '',
  ].join('\n');

  it('keeps the state and counts the events in place of listing them', () => {
    assert.deepStrictEqual(replayLines(output, '1-1'), [
      'Batch 1-1, issue #1',
      '',
      'Events  2, left out here: foedrum replay 1-1 lists them',
      '',
      'State',
      '  lane    on tap: https://github.com/demo/web/pull/2',
    ]);
  });

  it('counts the events of what foedrum replay prints, and keeps its State (regression test)', () => {
    const url = 'https://github.com/demo/web/pull/2';
    const batch: Batch = {
      id: '1-1',
      issue: 1,
      lane: { kind: 'on_tap', pullRequests: [url] },
      steps: new Map(),
      rewinds: [],
    };
    const events: StoredEvent[] = [
      {
        id: 1,
        event: {
          type: 'batch.ordered',
          batchId: '1-1',
          order: { issue: 1 },
          routeBy: '2026-10-30T10:00:00.000Z',
        },
      },
      { id: 2, event: { type: 'batch.on_tap', batchId: '1-1', pullRequests: [url] } },
    ];
    const lines = replayLines(formatReplay(batch, events), '1-1');
    assert.ok(
      lines.includes('Events  2, left out here: foedrum replay 1-1 lists them'),
      lines.join('\n'),
    );
    assert.ok(lines.includes('State'), lines.join('\n'));
    assert.ok(!lines.some((line) => line.includes('batch.on_tap')), lines.join('\n'));
  });

  it('counts the events up to the end of an output that ends with them (regression test)', () => {
    const ended =
      'Batch 1-1, issue #1\n\nEvents\n   1  batch.ordered  {}\n   2  batch.on_tap   {}\n';
    assert.deepStrictEqual(replayLines(ended, '1-1'), [
      'Batch 1-1, issue #1',
      '',
      'Events  2, left out here: foedrum replay 1-1 lists them',
    ]);
  });

  it('leaves an output without events as it is', () => {
    assert.deepStrictEqual(replayLines('No batch 9-9.\n', '9-9'), ['No batch 9-9.']);
  });
});
