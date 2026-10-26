// `foedrum brewers` (ADR 0159): the report per brewer over the folded events, each step's brewer
// from the recipe its batch chose, as the files are now.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type BrewerSource,
  brewerReport,
  brewerSource,
  formatBrewerReport,
  type LoadedBrewers,
  recipesRun,
} from '../../src/cli/brewer-report.ts';
import { fold } from '../../src/engine/fold.ts';
import type { StepBrewer } from '../../src/engine/recipe-files.ts';
import type { Event, Usage } from '../../src/schemas/events.ts';
import { fakeRecipe, fakeRecipes } from '../helpers/fake-recipes.ts';

const deadlineAt = '2026-10-23T10:00:00.000Z';
const remindAt = '2026-10-25T10:00:00.000Z';
const zero: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
const usage = (input: number, output: number, read: number, write: number): Usage => ({
  inputTokens: input,
  outputTokens: output,
  cacheReadTokens: read,
  cacheWriteTokens: write,
});
// The report over `events`, each attempt under the recipe its batch ran it in.
const report = (events: readonly Event[], from = source) =>
  brewerReport(fold(events), from, recipesRun(events));
const none = { succeeded: 0, failed: 0, needs_input: 0, cancelled: 0, unfinished: 0 };

// pint: plan (planner), test (a step without a brewer: a check or an action), implement (coder). The recipe `old` is gone, and
// pint has no step `review` any more.
const source: BrewerSource = {
  brewers: [
    { name: 'planner', path: 'defaults/brewers/planner.md' },
    { name: 'reviewer', path: 'brewers/reviewer.md' },
    { name: 'coder', path: 'brewers/coder.md' },
  ],
  step: (recipe, stepId) => {
    if (recipe !== 'pint') return undefined;
    if (stepId === 'plan') return { brewer: 'planner' };
    if (stepId === 'implement') return { brewer: 'coder' };
    if (stepId === 'test') return { brewer: undefined };
    return undefined;
  },
};

const ordered = (batchId: string, issue: number, recipe?: string): Event[] => [
  { type: 'batch.ordered', batchId, order: { issue }, routeBy: deadlineAt },
  ...(recipe === undefined
    ? []
    : [
        {
          type: 'batch.recipe_chosen',
          batchId,
          recipe,
          reason: 'label',
          source: 'label',
        } satisfies Event,
      ]),
];
const scheduled = (batchId: string, stepId: string, attempt: number): Event => ({
  type: 'step.scheduled',
  batchId,
  stepId,
  attempt,
  deadlineAt,
});
const started = (batchId: string, stepId: string, attempt: number): Event[] => [
  scheduled(batchId, stepId, attempt),
  { type: 'step.started', batchId, stepId, attempt },
];
const finished = (
  batchId: string,
  stepId: string,
  attempt: number,
  outcome: Extract<Event, { type: 'step.finished' }>['outcome'],
  spent?: Usage,
): Event[] => [
  ...started(batchId, stepId, attempt),
  {
    type: 'step.finished',
    batchId,
    stepId,
    attempt,
    outcome,
    ...(spent === undefined ? {} : { usage: spent }),
  },
];
const question = {
  q: 'Keep the v1 endpoint?',
  options: ['keep', 'remove'],
  recommended: 'keep',
  whyBlocking: 'Removing it breaks the mobile app',
};

const events: Event[] = [
  // b1: plan failed then succeeded, the check step passed, implement asks a question.
  ...ordered('b1', 1, 'pint'),
  ...finished(
    'b1',
    'plan',
    1,
    { kind: 'failed', retryable: true, reason: 'tests' },
    usage(10, 20, 30, 40),
  ),
  ...finished('b1', 'plan', 2, { kind: 'succeeded', output: {} }, usage(1, 2, 3, 4)),
  ...finished('b1', 'test', 1, { kind: 'succeeded', output: {} }, usage(100, 100, 100, 100)),
  ...finished(
    'b1',
    'implement',
    1,
    { kind: 'needs_input', questions: [question] },
    usage(5, 5, 5, 5),
  ),
  {
    type: 'batch.stuck',
    batchId: 'b1',
    reason: { kind: 'needs_input', stepId: 'implement', questions: [question] },
    options: ['answer', 'retry', 'skip', 'recipe', 'rewind', 'cancel'],
    remindAt,
  },
  // b2: plan runs now.
  ...ordered('b2', 2, 'pint'),
  ...started('b2', 'plan', 1),
  // b3: a recipe no file has now.
  ...ordered('b3', 3, 'old'),
  ...finished('b3', 'plan', 1, { kind: 'cancelled' }, usage(1, 1, 1, 1)),
  // b4: a step pint no longer has, which left the batch Stuck.
  ...ordered('b4', 4, 'pint'),
  ...finished('b4', 'review', 1, {
    kind: 'failed',
    retryable: false,
    reason: 'blocked (environment): no network',
  }),
  {
    type: 'batch.stuck',
    batchId: 'b4',
    reason: {
      kind: 'blocked',
      stepId: 'review',
      blockerKind: 'environment',
      summary: 'no network',
    },
    options: ['retry', 'skip', 'recipe', 'rewind', 'cancel'],
    remindAt,
  },
  // b5: implement's attempt never started before its deadline.
  ...ordered('b5', 5, 'pint'),
  scheduled('b5', 'implement', 1),
  {
    type: 'batch.stuck',
    batchId: 'b5',
    reason: { kind: 'deadline_passed', stepId: 'implement', deadlineAt },
    options: ['retry', 'skip', 'recipe', 'rewind', 'cancel'],
    remindAt,
  },
  // b6: never routed, so Stuck at no step and with no recipe.
  ...ordered('b6', 6),
  {
    type: 'batch.stuck',
    batchId: 'b6',
    reason: { kind: 'routing', deadlineAt },
    options: ['retry', 'recipe', 'cancel'],
    remindAt,
  },
];

describe('brewerReport', () => {
  it('counts each brewer’s started attempts, their outcomes, its Stuck batches and its tokens', () => {
    const { brewers } = report(events);
    assert.deepStrictEqual(brewers, [
      {
        name: 'coder',
        path: 'brewers/coder.md',
        attempts: 1,
        outcomes: { ...none, needs_input: 1 },
        stuck: ['b1', 'b5'],
        usage: usage(5, 5, 5, 5),
      },
      {
        name: 'planner',
        path: 'defaults/brewers/planner.md',
        attempts: 3,
        outcomes: { ...none, succeeded: 1, failed: 1, unfinished: 1 },
        stuck: [],
        usage: usage(11, 22, 33, 44),
      },
      {
        name: 'reviewer',
        path: 'brewers/reviewer.md',
        attempts: 0,
        outcomes: none,
        stuck: [],
        usage: zero,
      },
    ]);
  });

  it('lists the attempts of steps the recipe files no longer have apart, by recipe and step', () => {
    assert.deepStrictEqual(report(events).gone, [
      {
        recipe: 'old',
        stepId: 'plan',
        attempts: 1,
        outcomes: { ...none, cancelled: 1 },
        stuck: [],
        usage: usage(1, 1, 1, 1),
      },
      {
        recipe: 'pint',
        stepId: 'review',
        attempts: 1,
        outcomes: { ...none, failed: 1 },
        stuck: ['b4'],
        usage: zero,
      },
    ]);
  });

  it('lists every brewer in use with nothing beside it when no batch ran', () => {
    assert.deepStrictEqual(report([]), {
      brewers: ['coder', 'planner', 'reviewer'].map((name) => ({
        name,
        path: source.brewers.find((brewer) => brewer.name === name)?.path,
        attempts: 0,
        outcomes: none,
        stuck: [],
        usage: zero,
      })),
      gone: [],
    });
  });

  it('credits each attempt to the brewer of the recipe its batch ran it under', () => {
    // stout's plan is the brewmaster's, and stout has no implement.
    const both: BrewerSource = {
      brewers: [...source.brewers, { name: 'brewmaster', path: 'brewers/brewmaster.md' }],
      step: (recipe, stepId) =>
        recipe === 'stout'
          ? stepId === 'plan'
            ? { brewer: 'brewmaster' }
            : undefined
          : source.step(recipe, stepId),
    };
    // b8 brewed pint until implement used up its attempts, then a person chose stout.
    const changed = report(
      [
        ...ordered('b8', 8, 'pint'),
        ...finished('b8', 'plan', 1, { kind: 'succeeded', output: {} }, usage(1, 0, 0, 0)),
        ...finished(
          'b8',
          'implement',
          1,
          { kind: 'failed', retryable: true, reason: 'tests' },
          usage(0, 1, 0, 0),
        ),
        {
          type: 'batch.stuck',
          batchId: 'b8',
          reason: {
            kind: 'attempts_exhausted',
            stepId: 'implement',
            attempts: 1,
            lastReason: 'tests',
          },
          options: ['retry', 'skip', 'recipe', 'rewind', 'cancel'],
          remindAt,
        },
        {
          type: 'batch.recipe_chosen',
          batchId: 'b8',
          recipe: 'stout',
          reason: 'start over',
          source: 'human',
          by: 'ada',
          via: 'terminal',
        },
        ...finished('b8', 'plan', 2, { kind: 'succeeded', output: {} }, usage(0, 0, 1, 0)),
      ],
      both,
    );
    const tally = (name: string) => {
      const { attempts, usage: spent } =
        changed.brewers.find((brewer) => brewer.name === name) ?? {};
      return { attempts, usage: spent };
    };
    assert.deepStrictEqual(tally('planner'), { attempts: 1, usage: usage(1, 0, 0, 0) });
    assert.deepStrictEqual(tally('coder'), { attempts: 1, usage: usage(0, 1, 0, 0) });
    assert.deepStrictEqual(tally('brewmaster'), { attempts: 1, usage: usage(0, 0, 1, 0) });
    assert.deepStrictEqual(changed.gone, []);
  });

  it('gives a batch Stuck at no step to no brewer, also when it had a recipe', () => {
    // b9 brewed pint, was sent back to Ordered by a retry, and was not routed again in time.
    const routing = report([
      ...ordered('b9', 9, 'pint'),
      ...finished('b9', 'plan', 1, { kind: 'succeeded', output: {} }),
      {
        type: 'batch.stuck',
        batchId: 'b9',
        reason: { kind: 'routing', deadlineAt },
        options: ['retry', 'recipe', 'cancel'],
        remindAt,
      },
    ]);
    assert.deepStrictEqual(
      routing.brewers.flatMap(({ stuck }) => stuck),
      [],
    );
    assert.deepStrictEqual(routing.gone, []);
  });

  it('sorts the steps the files no longer have by recipe, then step', () => {
    const lost = report([
      ...ordered('b1', 1, 'zz'),
      ...finished('b1', 'b', 1, { kind: 'cancelled' }),
      ...ordered('b2', 2, 'pint'),
      ...finished('b2', 'zeta', 1, { kind: 'cancelled' }),
      ...finished('b2', 'alpha', 1, { kind: 'cancelled' }),
    ]);
    assert.deepStrictEqual(
      lost.gone.map(({ recipe, stepId }) => `${recipe}/${stepId}`),
      ['pint/alpha', 'pint/zeta', 'zz/b'],
    );
  });

  it('lists a brewer a step names that is not among the brewers in use, without a file', () => {
    const ghostly: BrewerSource = {
      ...source,
      step: (recipe, stepId) =>
        stepId === 'plan' ? { brewer: 'ghost' } : source.step(recipe, stepId),
    };
    const { brewers } = report(
      [...ordered('b1', 1, 'pint'), ...finished('b1', 'plan', 1, { kind: 'cancelled' })],
      ghostly,
    );
    assert.deepStrictEqual(
      brewers.map(({ name, path, attempts }) => [name, path, attempts]),
      [
        ['coder', 'brewers/coder.md', 0],
        ['ghost', '', 1],
        ['planner', 'defaults/brewers/planner.md', 0],
        ['reviewer', 'brewers/reviewer.md', 0],
      ],
    );
  });

  it("takes each batch's own recipe when batches choose theirs between each other's attempts", () => {
    // b1 chose pint, then b2 chose a recipe no file has, then b1's plan was scheduled.
    const events: Event[] = [
      ...ordered('b1', 1, 'pint'),
      ...ordered('b2', 2, 'old'),
      ...finished('b1', 'plan', 1, { kind: 'succeeded', output: {} }),
    ];
    assert.deepStrictEqual(
      recipesRun(events),
      new Map([[JSON.stringify(['b1', 'plan', 1]), 'pint']]),
    );
    const interleaved = report(events);
    assert.equal(interleaved.brewers.find(({ name }) => name === 'planner')?.attempts, 1);
    assert.deepStrictEqual(interleaved.gone, []);
  });

  it('gives a batch Stuck at a step without a brewer to no brewer', () => {
    const atCheck = report([
      ...ordered('b1', 1, 'pint'),
      ...finished('b1', 'test', 1, { kind: 'failed', retryable: true, reason: 'tests fail' }),
      {
        type: 'batch.stuck',
        batchId: 'b1',
        reason: {
          kind: 'attempts_exhausted',
          stepId: 'test',
          attempts: 1,
          lastReason: 'tests fail',
        },
        options: ['retry', 'skip', 'recipe', 'rewind', 'cancel'],
        remindAt,
      },
    ]);
    assert.deepStrictEqual(
      atCheck.brewers.flatMap(({ stuck }) => stuck),
      [],
    );
    assert.deepStrictEqual(atCheck.gone, []);
  });

  it("counts an attempt `ran` does not have under the batch's recipe now", () => {
    const events = [
      ...ordered('b1', 1, 'pint'),
      ...finished('b1', 'plan', 1, { kind: 'succeeded', output: {} }),
    ];
    const { brewers } = brewerReport(fold(events), source, new Map());
    assert.equal(brewers.find(({ name }) => name === 'planner')?.attempts, 1);
  });

  it('counts an attempt abandoned when its batch went Stuck as unfinished', () => {
    const abandoned = report([
      ...ordered('b7', 7, 'pint'),
      ...started('b7', 'plan', 1),
      {
        type: 'batch.stuck',
        batchId: 'b7',
        reason: { kind: 'deadline_passed', stepId: 'plan', deadlineAt },
        options: ['retry', 'skip', 'recipe', 'rewind', 'cancel'],
        remindAt,
      },
    ]);
    const planner = abandoned.brewers.find(({ name }) => name === 'planner');
    assert.deepStrictEqual(planner?.outcomes, { ...none, unfinished: 1 });
    assert.deepStrictEqual(planner?.stuck, ['b7']);
  });
});

describe('formatBrewerReport', () => {
  it('prints each brewer with its file, its outcomes, its tokens and its Stuck batches, then the steps that are gone', () => {
    assert.equal(
      formatBrewerReport(report(events)),
      [
        'coder  brewers/coder.md',
        '  1 attempt: 1 needs input',
        '  tokens: 5 input, 5 output, 5 cache read, 5 cache write',
        '  Stuck: b1, b5',
        'planner  defaults/brewers/planner.md',
        '  3 attempts: 1 succeeded, 1 failed, 1 unfinished',
        '  tokens: 11 input, 22 output, 33 cache read, 44 cache write',
        'reviewer  brewers/reviewer.md',
        '  no attempts',
        '',
        'Steps the recipe files no longer have (ADR 0059):',
        'old/plan',
        '  1 attempt: 1 cancelled',
        '  tokens: 1 input, 1 output, 1 cache read, 1 cache write',
        'pint/review',
        '  1 attempt: 1 failed',
        '  tokens: none reported',
        '  Stuck: b4',
        '',
      ].join('\n'),
    );
  });

  it('groups the digits of large token counts', () => {
    const large = report(
      [
        ...ordered('b1', 1, 'pint'),
        ...finished('b1', 'plan', 1, { kind: 'succeeded', output: {} }, usage(1234567, 0, 0, 0)),
      ],
      { ...source, brewers: [{ name: 'planner', path: 'brewers/planner.md' }] },
    );
    assert.equal(
      formatBrewerReport(large),
      [
        'planner  brewers/planner.md',
        '  1 attempt: 1 succeeded',
        '  tokens: 1,234,567 input, 0 output, 0 cache read, 0 cache write',
        '',
      ].join('\n'),
    );
  });

  it('says so when the Brewery has no brewer', () => {
    assert.equal(formatBrewerReport(report([], { ...source, brewers: [] })), 'No brewers.\n');
  });
});

describe('brewerSource', () => {
  // pint: plan (planner), green (a check step) and open-pull-request (an action step), from
  // loaded files.
  const stepBrewer = (name: string) =>
    ({ brewer: { name }, instructions: '' }) as unknown as StepBrewer;
  const loaded: LoadedBrewers = {
    recipes: fakeRecipes({ pint: fakeRecipe({ steps: ['plan', 'green', 'open-pull-request'] }) }),
    brewers: {
      find: (recipe, stepId) =>
        recipe === 'pint' && stepId === 'plan' ? stepBrewer('planner') : undefined,
    },
    catalog: {
      brewers: [
        { ...stepBrewer('planner'), name: 'planner', path: 'brewers/planner.md' },
        { ...stepBrewer('coder'), name: 'coder', path: 'defaults/brewers/coder.md' },
      ],
      lenses: [],
      named: { brewers: new Set(['planner']), lenses: new Set(), reviewLenses: new Set() },
    },
  };

  it('lists every brewer of the catalog with its file', () => {
    assert.deepStrictEqual(brewerSource(loaded).brewers, [
      { name: 'planner', path: 'brewers/planner.md' },
      { name: 'coder', path: 'defaults/brewers/coder.md' },
    ]);
  });

  it("gives a brewer step's brewer, none for a check or an action step, and nothing for a step no recipe has", () => {
    const { step } = brewerSource(loaded);
    assert.deepStrictEqual(step('pint', 'plan'), { brewer: 'planner' });
    assert.deepStrictEqual(step('pint', 'green'), { brewer: undefined });
    assert.deepStrictEqual(step('pint', 'open-pull-request'), { brewer: undefined });
    assert.equal(step('pint', 'review'), undefined);
    assert.equal(step('stout', 'plan'), undefined);
  });
});
