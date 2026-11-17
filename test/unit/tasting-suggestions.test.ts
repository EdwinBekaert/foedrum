import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type ModelUsed,
  modelsUsed,
  type StepInUse,
  type TastingInputs,
  tastingSuggestions,
} from '../../src/engine/tasting-suggestions.ts';
import type { Event } from '../../src/schemas/events.ts';
import type { TastedEntry } from '../../src/schemas/models.ts';

const now = new Date('2026-11-30T12:00:00.000Z');
const daysAgo = (days: number): Date => new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

const used = (over: Partial<ModelUsed> = {}): ModelUsed => ({
  recipe: 'nip',
  stepId: 'brew',
  model: 'claude-opus-5-6',
  deadlineAt: daysAgo(1),
  ...over,
});

// nip's brew is the Cellarman's on strong, its gauge the Gauger's on standard; stout's brew the
// Cellarman's on standard.
const STEPS: Readonly<Record<string, StepInUse>> = {
  'nip/brew': { brewer: 'cellarman', level: 'strong', effort: 'larger' },
  'nip/gauge': { brewer: 'gauger', level: 'standard', effort: 'moderate' },
  'nip/map': { brewer: 'maltster-map', level: 'light', effort: 'small' },
  'stout/brew': { brewer: 'cellarman', level: 'standard', effort: 'larger' },
};
const stepOf = (recipe: string, stepId: string): StepInUse | undefined =>
  STEPS[`${recipe}/${stepId}`];

const entry = (over: Partial<TastedEntry> = {}): TastedEntry => ({
  brewer: 'cellarman',
  recipe: 'nip',
  level: 'strong',
  effort: 'larger',
  model: 'claude-opus-5-6',
  passed: 9,
  runs: 10,
  baseline: { passed: 8, runs: 10, model: 'claude-opus-5-5' },
  tokensPerOrder: 412000,
  date: '2026-11-20',
  ...over,
});

const suggest = (inputs: Partial<TastingInputs>) =>
  tastingSuggestions({ attempts: [], stepOf, tasted: [], now, ...inputs });

describe('tastingSuggestions: models in use never tasted (ADR 0419)', () => {
  it('lists a model in use that no tasted entry covers, with every brewer that ran it', () => {
    const result = suggest({
      attempts: [
        used({ stepId: 'gauge' }),
        used({ model: 'claude-sonnet-5-6', stepId: 'gauge' }),
        used(),
        used({ stepId: 'gauge' }),
      ],
    });
    assert.deepEqual(result.untasted, [
      { model: 'claude-opus-5-6', brewers: ['cellarman', 'gauger'] },
      { model: 'claude-sonnet-5-6', brewers: ['gauger'] },
    ]);
  });

  it('takes a model as tasted for a brewer with an entry of that brewer on that model in any recipe, level and effort', () => {
    const result = suggest({
      attempts: [used()],
      tasted: [entry({ recipe: 'stout', level: 'standard', effort: 'moderate', passed: 1 })],
    });
    assert.deepEqual(result.untasted, []);
  });

  it('still lists a model for a brewer when only another brewer was tasted on it', () => {
    const result = suggest({ attempts: [used()], tasted: [entry({ brewer: 'gauger' })] });
    assert.deepEqual(result.untasted, [{ model: 'claude-opus-5-6', brewers: ['cellarman'] }]);
  });

  it('still lists a model for a brewer tasted only on another model', () => {
    const result = suggest({ attempts: [used()], tasted: [entry({ model: 'claude-opus-5-5' })] });
    assert.deepEqual(result.untasted, [{ model: 'claude-opus-5-6', brewers: ['cellarman'] }]);
  });

  it('reads only the attempts whose deadline falls in the last 30 days', () => {
    const result = suggest({
      attempts: [
        used({ deadlineAt: daysAgo(30) }),
        used({ model: 'claude-opus-5-1', deadlineAt: daysAgo(30.001) }),
      ],
    });
    assert.deepEqual(result.untasted, [{ model: 'claude-opus-5-6', brewers: ['cellarman'] }]);
  });

  it('leaves out an attempt whose step its recipe no longer has', () => {
    const result = suggest({
      attempts: [used({ stepId: 'gone' }), used({ recipe: 'gone', model: 'claude-opus-5-1' })],
    });
    assert.deepEqual(result, { untasted: [], cheaper: [] });
  });
});

describe('tastingSuggestions: a cheaper level that might be enough (ADR 0419)', () => {
  it('suggests the level below for a step whose tasted entry did no worse than its baseline', () => {
    const result = suggest({ attempts: [used()], tasted: [entry()] });
    assert.deepEqual(result.cheaper, [
      {
        brewer: 'cellarman',
        recipe: 'nip',
        stepId: 'brew',
        from: 'strong',
        to: 'standard',
        effort: 'larger',
      },
    ]);
  });

  it('counts passes equal to the baseline’s as no worse', () => {
    const tasted = [entry({ passed: 8 })];
    assert.equal(suggest({ attempts: [used()], tasted }).cheaper.length, 1);
  });

  it('suggests nothing when the entry passed fewer orders than its baseline', () => {
    const tasted = [entry({ passed: 7 })];
    assert.deepEqual(suggest({ attempts: [used()], tasted }).cheaper, []);
  });

  it('suggests nothing when the entry and its baseline measured a different number of orders', () => {
    const tasted = [entry({ passed: 9, runs: 10, baseline: { ...entry().baseline, runs: 9 } })];
    assert.deepEqual(suggest({ attempts: [used()], tasted }).cheaper, []);
  });

  it('suggests nothing when the level below already has an entry of the same brewer, recipe and effort', () => {
    const tasted = [entry(), entry({ level: 'standard', passed: 2 })];
    assert.deepEqual(suggest({ attempts: [used()], tasted }).cheaper, []);
  });

  it('still suggests the level below when only another effort was tasted there', () => {
    const tasted = [entry(), entry({ level: 'standard', effort: 'full' })];
    assert.equal(suggest({ attempts: [used()], tasted }).cheaper.length, 1);
  });

  it('suggests nothing when the entry was tasted on another model than the one in use', () => {
    const tasted = [entry({ model: 'claude-opus-5-5' })];
    assert.deepEqual(suggest({ attempts: [used()], tasted }).cheaper, []);
  });

  it('suggests nothing when the entry is of the step’s brewer at another effort', () => {
    const tasted = [entry({ effort: 'full' })];
    assert.deepEqual(suggest({ attempts: [used()], tasted }).cheaper, []);
  });

  it('suggests nothing when the entry is of another recipe', () => {
    const tasted = [entry({ recipe: 'stout' })];
    assert.deepEqual(suggest({ attempts: [used()], tasted }).cheaper, []);
  });

  it('suggests nothing below the light level', () => {
    const attempts = [used({ stepId: 'map', model: 'claude-haiku-5-5' })];
    const tasted = [
      entry({ brewer: 'maltster-map', level: 'light', effort: 'small', model: 'claude-haiku-5-5' }),
    ];
    assert.deepEqual(suggest({ attempts, tasted }).cheaper, []);
  });

  it('lists each step once, by brewer, recipe and step, however many attempts ran it', () => {
    const attempts = [used({ recipe: 'stout', model: 'claude-sonnet-5-6' }), used(), used()];
    const tasted = [
      entry(),
      entry({ recipe: 'stout', level: 'standard', model: 'claude-sonnet-5-6' }),
    ];
    assert.deepEqual(
      suggest({ attempts, tasted }).cheaper.map(({ recipe, to }) => `${recipe} ${to}`),
      ['nip standard', 'stout light'],
    );
  });
});

describe('modelsUsed', () => {
  const chosen = (batchId: string, recipe: string): Event => ({
    type: 'batch.recipe_chosen',
    batchId,
    recipe,
    reason: 'label',
    source: 'label',
  });
  const scheduled = (
    batchId: string,
    stepId: string,
    attempt: number,
    deadlineAt: string,
  ): Event => ({
    type: 'step.scheduled',
    batchId,
    stepId,
    attempt,
    deadlineAt,
  });
  const finished = (batchId: string, stepId: string, attempt: number, model?: string): Event => ({
    type: 'step.finished',
    batchId,
    stepId,
    attempt,
    outcome: { kind: 'succeeded', output: null },
    ...(model === undefined ? {} : { claude: { version: '2.1.301', model } }),
  });

  it('reads each attempt’s model with the recipe and deadline it was scheduled under', () => {
    const events: Event[] = [
      chosen('b1', 'nip'),
      chosen('b2', 'stout'),
      scheduled('b1', 'brew', 1, '2026-11-20T10:00:00.000Z'),
      scheduled('b2', 'brew', 1, '2026-11-21T10:00:00.000Z'),
      finished('b1', 'brew', 1, 'claude-opus-5-6'),
      scheduled('b1', 'brew', 2, '2026-11-22T10:00:00.000Z'),
      chosen('b1', 'deep-brew'),
      finished('b2', 'brew', 1, 'claude-sonnet-5-6'),
      finished('b1', 'brew', 2, 'claude-opus-5-7'),
    ];
    assert.deepEqual(modelsUsed(events), [
      {
        recipe: 'nip',
        stepId: 'brew',
        model: 'claude-opus-5-6',
        deadlineAt: new Date('2026-11-20T10:00:00.000Z'),
      },
      {
        recipe: 'stout',
        stepId: 'brew',
        model: 'claude-sonnet-5-6',
        deadlineAt: new Date('2026-11-21T10:00:00.000Z'),
      },
      {
        recipe: 'nip',
        stepId: 'brew',
        model: 'claude-opus-5-7',
        deadlineAt: new Date('2026-11-22T10:00:00.000Z'),
      },
    ]);
  });

  it('leaves out an attempt that ended before claude’s init event', () => {
    const events: Event[] = [
      chosen('b1', 'nip'),
      scheduled('b1', 'brew', 1, '2026-11-20T10:00:00.000Z'),
      finished('b1', 'brew', 1),
    ];
    assert.deepEqual(modelsUsed(events), []);
  });
});
