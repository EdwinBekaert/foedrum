// A brewer's handover (ADR 0340): its out doc can end with what it learned. The engine keeps that
// beside the outcome, a person reads it, and no later prompt holds it.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createAttemptPlans } from '../../src/brewers/attempt-plans.ts';
import type { OutDocRead } from '../../src/brewers/claude-runner.ts';
import { formatHandovers } from '../../src/cli/commands.ts';
import { type AttemptLimits, settleAttempt } from '../../src/engine/brewer-runner.ts';
import { FOEDRUM_DEFAULTS, readBreweryFiles } from '../../src/engine/brewery-files.ts';
import { fold } from '../../src/engine/fold.ts';
import { handoverOf, handoversOf, withoutHandover } from '../../src/engine/handover.ts';
import { pullRequestText } from '../../src/engine/pull-request.ts';
import { loadRecipes } from '../../src/engine/recipe-files.ts';
import { renderStatus } from '../../src/engine/status-comment.ts';
import type { Event } from '../../src/schemas/events.ts';
import { OutDocFrontmatter, readOutDoc, TastingOutDoc } from '../../src/schemas/out-doc.ts';
import { brewerText, recipeText } from '../helpers/brewery-files.ts';

// Built at run time, so no scanner takes this file for one that holds a token.
const token = ['ghp', 'A1b2'.repeat(9)].join('_');
const LESSON = 'The fixture parser drops the last line of a file';
const deadlineAt = '2026-11-06T13:00:00.000Z';
const sessionId = '0f8fad5b-d9cb-469f-a165-70867728950e';

const docWith = (frontmatter: Record<string, unknown>, body = 'What I did.\n'): string =>
  `---\n${JSON.stringify(frontmatter)}\n---\n${body}`;
const done = { status: 'done', summary: 'Wrote it', assumptions: [] };
const withLesson = (fields: Record<string, unknown> = {}, body?: string): string =>
  docWith({ ...done, ...fields, handover: [LESSON] }, body);

const limits: AttemptLimits = { outDoc: { file: 'out.md', schema: OutDocFrontmatter } };
const settled = (outDoc: string, schema = limits) =>
  settleAttempt(
    { exit: { kind: 'exited', code: 0 }, outDoc, denials: 0, deniedTools: [], turns: 1 },
    schema,
  );

describe('an out doc with a handover', () => {
  it('an out doc with no handover reads as before', () => {
    const text = docWith(done);
    assert.deepEqual(settled(text), { kind: 'succeeded', output: done });
    assert.deepEqual(handoverOf(text, 'gauge'), []);
    assert.equal(withoutHandover(text), text);
  });

  it('keeps every byte of an out doc with no handover for a later prompt: comments and line ends', () => {
    const text =
      '---\r\n// a note\r\n{ "status": "done",  "summary": "s", "assumptions": [] }\r\n---\r\nBody\r\n';
    assert.equal(withoutHandover(text), text);
  });

  it('leaves its handover out of the recorded output, and the attempt succeeds', () => {
    assert.deepEqual(settled(withLesson()), { kind: 'succeeded', output: done });
  });

  it("leaves its handover out of a Taster's recorded output too", () => {
    const tasting = { ...done, verdict: 'approve', findings: [] };
    const ending = settled(docWith({ ...tasting, handover: [LESSON] }), {
      outDoc: { file: 'out.md', schema: TastingOutDoc },
    });
    assert.deepEqual(ending, { kind: 'succeeded', output: tasting });
  });

  it('never fails an attempt over the shape of its handover', () => {
    for (const handover of [7, 'one line', { a: 1 }, [1, 2], null, ['x'.repeat(5_000)]]) {
      const ending = settled(docWith({ ...done, handover }));
      assert.deepEqual(ending, { kind: 'succeeded', output: done }, JSON.stringify(handover));
    }
  });

  it("gives a retry's reason none of it: regression test", () => {
    const ending = settled(docWith({ status: 'failed', summary: 'Gave up', handover: [LESSON] }));
    assert.deepEqual(ending, {
      kind: 'failed',
      retryable: true,
      reason: 'the brewer failed: Gave up',
    });
  });

  it("reads a Taster's out doc without its handover: regression test", () => {
    const tasting = { ...done, verdict: 'approve', findings: [] };
    const read = readOutDoc(docWith({ ...tasting, handover: [LESSON] }), TastingOutDoc);
    assert.ok(read.valid);
    assert.equal('handover' in read.frontmatter, false);
    assert.deepEqual(read.frontmatter.findings, []);
  });

  it('still refuses any other key the schema does not know: regression test', () => {
    assert.equal(settled(docWith({ ...done, handovers: [LESSON] })).kind, 'failed');
  });
});

describe('handoverOf', () => {
  it('reads the lines of any out doc whose frontmatter parses, whatever its status', () => {
    for (const status of ['done', 'blocked', 'failed', 'needs_input']) {
      assert.deepEqual(handoverOf(docWith({ status, handover: [LESSON] }), 'gauge'), [LESSON]);
    }
  });

  it('reads none from an out doc whose frontmatter does not parse', () => {
    assert.deepEqual(handoverOf('---\n{ nope\n---\nhandover', 'gauge'), []);
    assert.deepEqual(handoverOf('handover: not frontmatter', 'gauge'), []);
  });

  it('reads none from a handover that is no list', () => {
    for (const handover of [7, LESSON, { a: LESSON }, null]) {
      assert.deepEqual(handoverOf(docWith({ handover }), 'gauge'), [], JSON.stringify(handover));
    }
  });

  it('keeps the strings of a list, and no other item', () => {
    assert.deepEqual(handoverOf(docWith({ handover: [1, LESSON, null] }), 'gauge'), [LESSON]);
  });

  it('keeps the first three lines', () => {
    const handover = ['one', 'two', 'three', 'four'];
    assert.deepEqual(handoverOf(docWith({ handover }), 'gauge'), ['one', 'two', 'three']);
  });

  it('counts the three after a blank line is dropped', () => {
    const handover = ['  ', 'one', 'two', 'three', 'four'];
    assert.deepEqual(handoverOf(docWith({ handover }), 'gauge'), ['one', 'two', 'three']);
  });

  it('makes each line one line: a line feed, a carriage return, U+2028 and U+2029', () => {
    const handover = ['a\nb\r\nc d e', '  f  '];
    assert.deepEqual(handoverOf(docWith({ handover }), 'gauge'), ['a b c d e', 'f']);
  });

  it('cuts a line past its limit, with a mark, on any line of the three', () => {
    const CUT = ' [cut: the rest is past the limit of 300 characters]';
    const handover = ['short', 'x'.repeat(5_000), 'y'.repeat(300)];
    const [short, long, whole] = handoverOf(docWith({ handover }), 'gauge');
    assert.equal(short, 'short');
    assert.equal(long, `${'x'.repeat(300 - CUT.length)}${CUT}`);
    assert.equal(whole, 'y'.repeat(300));
  });

  it('leaves out a line past its limit whose secret the cut would break in two', () => {
    const line = `${'x '.repeat(135)}${token}`;
    assert.ok(line.length > 300);
    assert.deepEqual(handoverOf(docWith({ handover: [line] }), 'gauge'), [
      '[left out: a handover line past its limit that looks like a secret]',
    ]);
  });

  it('reads every line for a secret, however short, and names its step in its place', () => {
    const handover = [`the key is ${token}`, LESSON];
    assert.deepEqual(handoverOf(docWith({ handover }), 'gauge'), [
      '[left out: a text of step gauge that looks like a secret]',
      LESSON,
    ]);
  });

  it('leaves out a line that holds a full commit hash: no commit is known there', () => {
    const line = `see ${'a1b2c3d4'.repeat(5)}`;
    assert.deepEqual(handoverOf(docWith({ handover: [line] }), 'gauge'), [
      '[left out: a text of step gauge that looks like a secret]',
    ]);
  });

  it('finds a secret that only one line makes of two', () => {
    const [line] = handoverOf(docWith({ handover: [`password\n= ${'hunter2hunter2'}`] }), 'gauge');
    assert.equal(line, '[left out: a text of step gauge that looks like a secret]');
  });
});

describe('withoutHandover', () => {
  it('takes the field out and keeps the rest and the body', () => {
    const body = 'What I did.\n\n---\nA rule in the body.\n';
    const text = withoutHandover(withLesson({ extra: 'kept' }, body));
    assert.doesNotMatch(text, /fixture parser/);
    assert.equal(text, docWith({ ...done, extra: 'kept' }, body));
  });

  it('takes out a key JSON spells another way, or gives twice', () => {
    const escaped = `---\n{ "status": "done", "\\u0068andover": ["${LESSON}"] }\n---\nBody\n`;
    assert.doesNotMatch(withoutHandover(escaped), /fixture parser/);
    const twice = `---\n{ "handover": ["${LESSON}"], "status": "done", "handover": ["${LESSON}"] }\n---\nBody\n`;
    assert.doesNotMatch(withoutHandover(twice), /fixture parser/);
  });

  it('takes it out behind a BOM, as the reader reads one', () => {
    const text = `﻿${withLesson()}`;
    assert.doesNotMatch(withoutHandover(text), /fixture parser/);
  });

  it('leaves a text with no frontmatter as it is: there is no field in it', () => {
    assert.equal(withoutHandover('# Just a note\n'), '# Just a note\n');
  });

  it('takes it out of a frontmatter with CRLF line ends', () => {
    const text = `---\r\n{ "status": "done", "handover": ["${LESSON}"] }\r\n---\r\nBody\r\n`;
    assert.doesNotMatch(withoutHandover(text), /fixture parser/);
  });

  it('leaves a text whose first line only starts with the delimiter as it is', () => {
    for (const text of ['---x\nhandover\n', '---- a note\n', '--- \nhandover\n']) {
      assert.equal(withoutHandover(text), text, JSON.stringify(text));
    }
  });

  it('refuses a text that is only the opening delimiter', () => {
    assert.throws(() => withoutHandover('---'), { message: /its frontmatter does not read/ });
  });

  it('refuses a frontmatter it cannot read, rather than pass the field on', () => {
    assert.throws(() => withoutHandover(`---\n{ "handover": ["${LESSON}"], nope\n---\nBody\n`), {
      message: /its frontmatter does not read/,
    });
    assert.throws(() => withoutHandover(`---\n{ "handover": ["${LESSON}"] }\nno closing line\n`), {
      message: /its frontmatter does not read/,
    });
  });
});

describe('an unaccepted proposal and later prompts', () => {
  const recipes = loadRecipes({
    recipes: [
      {
        path: 'recipes/ale.jsonc',
        text: recipeText('ale', [
          { id: 'gauge', brewer: 'writer' },
          { id: 'brew', brewer: 'reader' },
          { id: 'fix', brewer: 'fixer' },
        ]),
      },
    ],
    brewers: [
      {
        path: 'brewers/writer.md',
        text: brewerText('writer', { output: { doc: 'gauge.md', schema: 'outDoc' } }),
      },
      {
        path: 'brewers/fixer.md',
        text: brewerText('fixer', { output: { doc: 'fix.md', schema: 'outDoc' } }),
      },
      {
        path: 'brewers/reader.md',
        text: brewerText('reader', {
          output: { doc: 'brew.md', schema: 'outDoc' },
          inputs: [{ name: 'tests', from: 'step:gauge' }],
        }),
      },
    ],
  });
  assert.ok(recipes.valid, recipes.valid ? '' : recipes.problems.join('\n'));

  const gaugeTree = join('/work', 'gauge-1');
  const brewTree = join('/work', 'brew-1');
  const gauge = { batchId: '12-1', stepId: 'gauge', attempt: 1 };
  const brew = { batchId: '12-1', stepId: 'brew', attempt: 1 };
  const inTree = (at: typeof gauge, path: string): Event => ({
    type: 'step.started',
    ...at,
    session: { id: sessionId, worktree: path },
    worktree: {
      repo: 'acme/api',
      path,
      branch: `foedrum/12-1/${at.stepId}/1`,
      commit: 'c'.repeat(40),
    },
  });
  const gauged: Event[] = [
    { type: 'batch.ordered', batchId: '12-1', order: { issue: 12 }, routeBy: deadlineAt },
    { type: 'batch.recipe_chosen', batchId: '12-1', recipe: 'ale', reason: 'l', source: 'label' },
    { type: 'step.scheduled', ...gauge, deadlineAt },
    inTree(gauge, gaugeTree),
    {
      type: 'step.finished',
      ...gauge,
      outcome: { kind: 'succeeded', output: done },
      handover: [LESSON],
    },
  ];
  const promptOf = async (
    events: Event[],
    files: Record<string, OutDocRead>,
    ref = brew,
    brewers = recipes.brewers,
  ) => {
    const plans = createAttemptPlans({
      state: () => fold(events),
      brewers,
      models: { models: { builder: 'claude-sonnet-5-5' }, brewers: {} },
      repoTools: () => [],
      clone: (repo) => join('/clones', repo),
      sandbox: false,
      workRoot: join('/root'),
      env: { base: { PATH: '/usr/bin' }, forced: {} },
      platform: 'linux',
      orderText: async () => 'Add a --json flag.',
      orderComments: async () => [],
      files: {
        read: (file) => files[file] ?? { kind: 'missing' },
        makeFolder: () => {},
      },
      random: () => Buffer.from('0123456789abcdef0123456789abcdef', 'hex'),
    });
    const { prompt } = await plans.plan({
      ref,
      limits: { outDoc: { file: 'brew.md', schema: OutDocFrontmatter } },
    });
    return prompt;
  };
  const gaugeDoc = { [join(gaugeTree, 'gauge.md')]: { kind: 'text', text: withLesson() } } as const;

  it('an unaccepted proposal reaches no later prompt', async () => {
    const events: Event[] = [
      ...gauged,
      { type: 'step.scheduled', ...brew, deadlineAt },
      inTree(brew, brewTree),
    ];
    const prompt = await promptOf(events, gaugeDoc);
    // The input was read: its body and the rest of its frontmatter are there.
    assert.match(prompt, /What I did\./);
    assert.match(prompt, /Wrote it/);
    assert.doesNotMatch(prompt, /fixture parser/);
  });

  it('reaches no route input: the out doc of the step that sent the batch back', async () => {
    const routed = { batchId: '12-1', stepId: 'fix', attempt: 1 };
    const events: Event[] = [
      ...gauged,
      { type: 'step.scheduled', ...routed, deadlineAt, route: { from: 'gauge', why: 'findings' } },
      inTree(routed, join('/work', 'fix-1')),
    ];
    const prompt = await promptOf(events, gaugeDoc, routed);
    assert.match(prompt, /Its out doc:/);
    assert.match(prompt, /What I did\./);
    assert.doesNotMatch(prompt, /fixture parser/);
  });

  it("reaches no plan input: a plan Taster's prompt", async () => {
    const tasting = loadRecipes({
      ...readBreweryFiles(join(FOEDRUM_DEFAULTS, 'no-such-brewery')),
      recipes: [
        {
          path: 'recipes/amber.jsonc',
          text: recipeText(
            'amber',
            [
              { id: 'plan', brewer: 'brewmaster' },
              { id: 'taste', brewer: 'taster', lens: 'plan/naive-reader' },
            ],
            { testFirst: false },
          ),
        },
      ],
      lenses: [{ path: 'lenses/plan/naive-reader.md', text: 'Read each sub-order alone.\n' }],
    });
    assert.ok(tasting.valid, tasting.valid ? '' : tasting.problems.join('\n'));
    const plan = { batchId: '12-1', stepId: 'plan', attempt: 1 };
    const taste = { batchId: '12-1', stepId: 'taste', attempt: 1 };
    const planTree = join('/work', 'plan-1');
    const planned = {
      ...done,
      subOrders: [
        {
          id: 'api',
          title: 'Build the API',
          repo: 'acme/api',
          size: { lines: 200, mechanism: 'one handler' },
          doneWhen: 'a test passes',
          touches: [{ path: 'src/api.ts' }],
          recipe: 'nip',
          why: 'it is the whole order',
          ready: true,
        },
      ],
    };
    const events: Event[] = [
      { type: 'batch.ordered', batchId: '12-1', order: { issue: 12 }, routeBy: deadlineAt },
      {
        type: 'batch.recipe_chosen',
        batchId: '12-1',
        recipe: 'amber',
        reason: 'l',
        source: 'label',
      },
      { type: 'step.scheduled', ...plan, deadlineAt },
      inTree(plan, planTree),
      { type: 'step.finished', ...plan, outcome: { kind: 'succeeded', output: planned } },
      { type: 'step.scheduled', ...taste, deadlineAt },
      inTree(taste, join('/work', 'taste-1')),
    ];
    const prompt = await promptOf(
      events,
      { [join(planTree, 'plan.md')]: { kind: 'text', text: withLesson({}, '# The plan\n') } },
      taste,
      tasting.brewers,
    );
    assert.match(prompt, /# The plan/);
    assert.doesNotMatch(prompt, /fixture parser/);
  });

  it('fails the attempt with a reason when a step input cannot be read without it', async () => {
    const events: Event[] = [
      ...gauged,
      { type: 'step.scheduled', ...brew, deadlineAt },
      inTree(brew, brewTree),
    ];
    const changed = `---\n{ "handover": ["${LESSON}"], nope\n---\nBody\n`;
    await assert.rejects(
      promptOf(events, { [join(gaugeTree, 'gauge.md')]: { kind: 'text', text: changed } }),
      /^Error: the input "tests" was not read: its frontmatter does not read/,
    );
  });

  it('says so in a route input when the out doc cannot be read without it', async () => {
    const routed = { batchId: '12-1', stepId: 'fix', attempt: 1 };
    const events: Event[] = [
      ...gauged,
      { type: 'step.scheduled', ...routed, deadlineAt, route: { from: 'gauge', why: 'findings' } },
      inTree(routed, join('/work', 'fix-1')),
    ];
    const changed = `---\n{ "handover": ["${LESSON}"], nope\n---\nBody\n`;
    const prompt = await promptOf(
      events,
      { [join(gaugeTree, 'gauge.md')]: { kind: 'text', text: changed } },
      routed,
    );
    assert.match(prompt, /Its out doc could not be read: its frontmatter does not read/);
    assert.doesNotMatch(prompt, /fixture parser/);
  });

  it('holds no model text in the status comment: only how many, and the command', () => {
    const batch = fold(gauged).batches.get('12-1');
    assert.ok(batch !== undefined);
    const text = renderStatus(batch, ['gauge', 'brew']);
    assert.match(text, /1 handover line: `foedrum handover 12`/);
    assert.doesNotMatch(text, /fixture parser/);
  });

  it('says nothing of a handover in the status comment of a batch with none: regression test', () => {
    const events = gauged.map((event) => {
      if (event.type !== 'step.finished') return event;
      const { handover: _, ...rest } = event;
      return rest;
    });
    const batch = fold(events).batches.get('12-1');
    assert.ok(batch !== undefined);
    assert.doesNotMatch(renderStatus(batch, ['gauge', 'brew']), /handover/);
  });

  it('counts the lines of the status comment across attempts', () => {
    const retried = { ...gauge, attempt: 2 };
    const events: Event[] = [
      ...gauged,
      { type: 'step.scheduled', ...retried, deadlineAt },
      inTree(retried, join('/work', 'gauge-2')),
      {
        type: 'step.finished',
        ...retried,
        outcome: { kind: 'succeeded', output: done },
        handover: ['Another', 'And another'],
      },
    ];
    const batch = fold(events).batches.get('12-1');
    assert.ok(batch !== undefined);
    assert.match(renderStatus(batch, ['gauge', 'brew']), /3 handover lines: `foedrum handover 12`/);
  });
});

describe('handoversOf', () => {
  const finished = (stepId: string, attempt: number, handover?: string[]): Event[] => [
    { type: 'step.scheduled', batchId: '12-1', stepId, attempt, deadlineAt },
    { type: 'step.started', batchId: '12-1', stepId, attempt },
    {
      type: 'step.finished',
      batchId: '12-1',
      stepId,
      attempt,
      outcome: { kind: 'failed', retryable: true, reason: 'tests fail' },
      ...(handover === undefined ? {} : { handover }),
    },
  ];
  const ordered: Event = {
    type: 'batch.ordered',
    batchId: '12-1',
    order: { issue: 12 },
    routeBy: deadlineAt,
  };
  const of = (events: Event[]) => {
    const batch = fold([ordered, ...events]).batches.get('12-1');
    assert.ok(batch !== undefined);
    return handoversOf(batch);
  };

  it('names each line by its step and attempt, a failed attempt too', () => {
    assert.deepEqual(of([...finished('gauge', 1, ['a', 'b']), ...finished('gauge', 2, ['c'])]), [
      { stepId: 'gauge', attempt: 1, text: 'a' },
      { stepId: 'gauge', attempt: 1, text: 'b' },
      { stepId: 'gauge', attempt: 2, text: 'c' },
    ]);
  });

  it("keeps steps apart, in the order they first ran, whatever an attempt's number", () => {
    assert.deepEqual(
      of([
        ...finished('taste', 1, ['t1']),
        ...finished('brew', 1, ['b1']),
        ...finished('taste', 2, ['t2']),
      ]),
      [
        { stepId: 'taste', attempt: 1, text: 't1' },
        { stepId: 'taste', attempt: 2, text: 't2' },
        { stepId: 'brew', attempt: 1, text: 'b1' },
      ],
    );
  });

  it('lists a line a resumed attempt left as it was once, under the attempt that wrote it', () => {
    assert.deepEqual(of([...finished('gauge', 1, ['same']), ...finished('gauge', 2, ['same'])]), [
      { stepId: 'gauge', attempt: 1, text: 'same' },
    ]);
  });

  it('lists the same words of two steps twice: each is its own', () => {
    assert.deepEqual(of([...finished('gauge', 1, ['same']), ...finished('brew', 1, ['same'])]), [
      { stepId: 'gauge', attempt: 1, text: 'same' },
      { stepId: 'brew', attempt: 1, text: 'same' },
    ]);
  });

  it('holds none for attempts that wrote none', () => {
    assert.deepEqual(of(finished('gauge', 1)), []);
  });
});

describe('formatHandovers', () => {
  it('numbers the lines of each attempt of each step on their own', () => {
    const text = formatHandovers('12-1', [
      { stepId: 'plan', attempt: 1, text: 'a' },
      { stepId: 'plan', attempt: 1, text: 'b' },
      { stepId: 'plan', attempt: 2, text: 'c' },
      { stepId: 'taste', attempt: 1, text: 'd' },
    ]);
    assert.deepEqual(text.split('\n').slice(1, -1), [
      'plan#1.1: a',
      'plan#1.2: b',
      'plan#2.1: c',
      'taste#1.1: d',
    ]);
  });
});

describe('the pull request body', () => {
  const text = (handovers?: { stepId: string; attempt: number; text: string }[]) =>
    pullRequestText({
      title: 'Clamp at ten',
      reports: [],
      ...(handovers === undefined ? {} : { handovers }),
    }).body;

  it('is byte for byte as before with no handover: regression test', () => {
    assert.equal(
      text([]),
      '## How this was brewed\n\nBrewed by Foedrum.\n\nNo How it works: the Cellarman wrote none.\n\nOpens as a draft: Foedrum marks it ready for review once its merge brief is posted.',
    );
  });

  it('lists each line by its step and attempt in a folded fence', () => {
    const body = text([
      { stepId: 'gauge', attempt: 2, text: LESSON },
      { stepId: 'taste', attempt: 1, text: 'Another' },
    ]);
    assert.match(body, /<details><summary>What the brewers handed over<\/summary>/);
    assert.match(
      body,
      /```text\ngauge#2: The fixture parser drops the last line of a file\ntaste#1: Another\n```/,
    );
  });

  it('sets its fence apart with blank lines, so GitHub reads a fence and not an HTML block', () => {
    const body = text([{ stepId: 'gauge', attempt: 1, text: '@someone Closes #12 <img src=x>' }]);
    assert.ok(
      body.includes(
        '<details><summary>What the brewers handed over</summary>\n\n```text\ngauge#1: @someone Closes #12 <img src=x>\n```\n\n</details>',
      ),
      body,
    );
  });

  it('keeps a run of backticks inside its fence', () => {
    const body = text([{ stepId: 'gauge', attempt: 1, text: 'see ```` and `````' }]);
    assert.match(body, /``````text\n/);
  });

  describe('beside the reports', () => {
    const reports = [{ stepId: 'brew', summary: 'y'.repeat(40_000), assumptions: [] }];
    const lines = Array.from({ length: 5 }, (_, at) => ({
      stepId: 'gauge',
      attempt: at + 1,
      text: 'a line',
    }));
    const bodyOf = (handovers: typeof lines) =>
      pullRequestText({ title: 'Clamp', reports, handovers, closes: { repo: 'a/b', issue: 7 } })
        .body;
    const between = (body: string, from: string, to: string) =>
      body.slice(body.indexOf(from), body.indexOf(to, body.indexOf(from)) + to.length);

    it('comes after the reports and before the closing line', () => {
      const body = bodyOf(lines);
      const reported = body.indexOf('What each step reported');
      const handed = body.indexOf('What the brewers handed over');
      assert.ok(reported >= 0 && reported < handed);
      assert.ok(handed < body.indexOf('Closes a/b#7'));
    });

    it("takes its room out of the reports', by its own length", () => {
      const reportsOf = (body: string) => between(body, 'What each step reported', '</details>');
      const blockOf = (body: string) =>
        between(body, '<details><summary>What the brewers', '</details>');
      const without = reportsOf(bodyOf([]));
      const withIt = bodyOf(lines);
      assert.equal(reportsOf(withIt).length, without.length - blockOf(withIt).length);
    });
  });

  it('cuts the newest lines past its room, says how many, and names the command', () => {
    const line = 'x'.repeat(300);
    const lines = Array.from({ length: 30 }, (_, at) => ({
      stepId: 'gauge',
      attempt: at + 1,
      text: line,
    }));
    const body = text(lines);
    assert.match(body, /gauge#1: x/);
    assert.doesNotMatch(body, /gauge#30: x/);
    const [, left] = /\((\d+) more: foedrum handover\)/.exec(body) ?? [];
    assert.ok(left !== undefined);
    const shown = [...body.matchAll(/gauge#\d+: x/g)].length;
    assert.equal(shown + Number(left), 30);
    const start = body.indexOf('<details><summary>What the brewers handed over');
    const block = body.slice(start, body.indexOf('</details>', start) + '</details>'.length);
    assert.ok(block.length <= 4_000, `${block.length}`);
  });
});
