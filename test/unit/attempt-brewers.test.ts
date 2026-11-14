// What the driver asks about an attempt's brewer, in the recipe the attempt was scheduled under
// (ADR 0309, ADR 0310).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { attemptBrewers } from '../../src/cli/attempt-brewers.ts';
import { fold } from '../../src/engine/fold.ts';
import { loadRecipes } from '../../src/engine/recipe-files.ts';
import type { Event } from '../../src/schemas/events.ts';
import type { ModelsConfig } from '../../src/schemas/models.ts';
import { brewerText, recipeText } from '../helpers/brewery-files.ts';
import { claudeModels } from '../helpers/models.ts';

const models: ModelsConfig = claudeModels({ standard: 'claude-sonnet-5-5', strong: 'opus' });

// Step brew of recipe first is a Maltster-like brewer: on Opus, resuming, surveying, testMapOnly.
// Step brew of recipe second is a plain brewer on Sonnet that starts fresh, testsUnchanged.
const loaded = loadRecipes({
  recipes: [
    {
      path: 'recipes/first.jsonc',
      text: recipeText('first', [{ id: 'brew', brewer: 'maltster' }]),
    },
    {
      path: 'recipes/second.jsonc',
      text: recipeText('second', [{ id: 'brew', brewer: 'builder' }]),
    },
    {
      path: 'recipes/talk.jsonc',
      text: recipeText('talk', [
        { id: 'brew', brewer: 'maltster', interactive: true, prompt: 'Talk it over.' },
      ]),
    },
  ],
  brewers: [
    {
      path: 'brewers/maltster.md',
      text: brewerText('maltster', {
        model: 'strong',
        retryMode: 'resume',
        output: { doc: 'survey.md', schema: 'survey' },
        guards: ['testMapOnly'],
      }),
    },
    {
      path: 'brewers/builder.md',
      text: brewerText('builder', {
        model: 'standard',
        retryMode: 'fresh',
        access: 'write',
        guards: ['testsUnchanged'],
      }),
    },
  ],
});
assert.ok(loaded.valid, JSON.stringify(loaded));

const ref = { batchId: '12-1', stepId: 'brew', attempt: 1 };
const chosen = (recipe: string): Event => ({
  type: 'batch.recipe_chosen',
  batchId: '12-1',
  recipe,
  reason: 'label',
  source: 'label',
});
const ordered: Event = {
  type: 'batch.ordered',
  batchId: '12-1',
  order: { issue: 12 },
  routeBy: '2026-10-17T13:00:00.000Z',
};
const scheduled: Event = { type: 'step.scheduled', ...ref, deadlineAt: '2026-10-17T13:00:00.000Z' };

const lookups = (events: readonly Event[]) => {
  const state = fold(events);
  return attemptBrewers({ state: () => state, brewers: loaded.brewers, models });
};

// brew#1 is scheduled under first, then a person chooses second before it starts (ADR 0240).
const switched = [ordered, chosen('first'), scheduled, chosen('second')];

describe('attemptBrewers (ADR 0310)', () => {
  it("an attempt's family comes from the recipe it was scheduled under after the batch switched recipes", () => {
    assert.equal(lookups(switched).family(ref), 'Opus');
  });

  it('whether an attempt resumes comes from the recipe it was scheduled under after the batch switched recipes', () => {
    assert.equal(lookups(switched).resumes(ref), true);
  });

  it('whether an attempt surveys comes from the recipe it was scheduled under after the batch switched recipes', () => {
    assert.equal(lookups(switched).surveys(ref), true);
  });

  it("an attempt's guards come from the recipe it was scheduled under after the batch switched recipes", () => {
    const brewers = lookups(switched);
    assert.equal(brewers.guarded(ref, 'testMapOnly'), true);
    assert.equal(brewers.guarded(ref, 'testsUnchanged'), false);
  });

  it('whether an attempt only reads comes from the recipe it was scheduled under: regression test', () => {
    assert.equal(lookups(switched).reads(ref), true);
  });

  it("an attempt of a batch that never switched recipes answers by its batch's recipe: regression test", () => {
    const brewers = lookups([ordered, chosen('second'), scheduled]);
    assert.equal(brewers.family(ref), 'Sonnet');
    assert.equal(brewers.resumes(ref), false);
    assert.equal(brewers.surveys(ref), false);
    assert.equal(brewers.guarded(ref, 'testMapOnly'), false);
    assert.equal(brewers.guarded(ref, 'testsUnchanged'), true);
    assert.equal(brewers.reads(ref), false);
  });

  it("an attempt that recorded no recipe reads its batch's: regression test", () => {
    // The step is scheduled before any recipe is chosen, so the attempt records none.
    const brewers = lookups([ordered, scheduled, chosen('first')]);
    assert.equal(brewers.family(ref), 'Opus');
    assert.equal(brewers.resumes(ref), true);
    assert.equal(brewers.surveys(ref), true);
    assert.equal(brewers.guarded(ref, 'testMapOnly'), true);
    assert.equal(brewers.reads(ref), true);
  });

  it('an interactive step never resumes, though its brewer does (ADR 0222): regression test', () => {
    assert.equal(lookups([ordered, chosen('talk'), scheduled]).resumes(ref), false);
  });

  it('an attempt of a step its recipe does not have answers nothing: regression test', () => {
    const brewers = lookups([ordered, chosen('first'), scheduled]);
    const other = { ...ref, stepId: 'taste' };
    assert.equal(brewers.family(other), undefined);
    assert.equal(brewers.resumes(other), false);
    assert.equal(brewers.surveys(other), false);
    assert.equal(brewers.guarded(other, 'testMapOnly'), false);
    assert.equal(brewers.reads(other), false);
  });
});
