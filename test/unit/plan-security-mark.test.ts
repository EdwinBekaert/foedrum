// A sub-order's security mark (ADR 0322): the Brewmaster's `securityMark` on a plan's entry, read from
// the recorded plan, shown in the plan entry and held to test-first. Nothing reaches a model or
// GitHub (ADR 0021).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createAttemptPlans } from '../../src/brewers/attempt-plans.ts';
import { FOEDRUM_DEFAULTS, readBreweryFiles } from '../../src/engine/brewery-files.ts';
import { fold } from '../../src/engine/fold.ts';
import { planEntryText, renderPlan } from '../../src/engine/plan-comment.ts';
import { loadRecipes } from '../../src/engine/recipe-files.ts';
import type { Event } from '../../src/schemas/events.ts';
import { OutDocFrontmatter, readOutDoc } from '../../src/schemas/out-doc.ts';
import { PlanOutDoc, planOf } from '../../src/schemas/plan.ts';

const at = '2026-11-05T10:00:00.000Z';
const securityMark = "the issue's title reaches the file path the writer saves to";

const subOrder = (id: string, more: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  title: `Build ${id}`,
  repo: 'acme/api',
  size: { lines: 120, mechanism: 'one writer' },
  doneWhen: 'the writer saves the page',
  touches: [{ path: 'src/writer.ts' }],
  dependencies: [],
  recipe: 'nip',
  why: 'a test pins it',
  ready: true,
  ...more,
});

const done = (...subOrders: unknown[]) => ({
  status: 'done',
  summary: 'Planned',
  assumptions: [],
  subOrders,
});

/** Batch 7-1 planned the order with `plan`, and a person approved it. */
const planned = (plan: unknown): Event[] => [
  { type: 'batch.ordered', batchId: '7-1', order: { issue: 7 }, routeBy: at },
  { type: 'step.scheduled', batchId: '7-1', stepId: 'plan', attempt: 1, deadlineAt: at },
  { type: 'step.started', batchId: '7-1', stepId: 'plan', attempt: 1 },
  {
    type: 'step.finished',
    batchId: '7-1',
    stepId: 'plan',
    attempt: 1,
    outcome: { kind: 'succeeded', output: plan },
  },
];

const origin = { batchId: '7-1', stepId: 'plan', attempt: 1, entry: 'writer' };

const brewers = () => {
  const loaded = loadRecipes(readBreweryFiles(join(FOEDRUM_DEFAULTS, 'no-such-brewery')));
  assert.ok(loaded.valid, loaded.valid ? '' : loaded.problems.join('\n'));
  return loaded.brewers;
};

const instructionsOf = (stepId: string, recipe = 'nip'): string => {
  const found = brewers().find(recipe, stepId);
  assert.ok(found);
  return found.instructions;
};

/** The prompt of step `stepId` of batch 12-1, Nip's, a sub-order of `plan`'s entry `writer`. */
const promptOf = async (stepId: string, plan: unknown): Promise<string> => {
  const ref = { batchId: '12-1', stepId, attempt: 1 };
  const path = join('/work', `${stepId}-1`);
  const events: Event[] = [
    ...planned(plan),
    {
      type: 'batch.ordered',
      batchId: '12-1',
      order: { issue: 12 },
      routeBy: at,
      parentBatchId: '7-1',
      plan: origin,
    },
    {
      type: 'batch.recipe_chosen',
      batchId: '12-1',
      recipe: 'nip',
      reason: 'label',
      source: 'label',
    },
    { type: 'step.scheduled', ...ref, deadlineAt: at },
    {
      type: 'step.started',
      ...ref,
      session: { id: '0f8fad5b-d9cb-469f-a165-70867728950e', worktree: path },
      worktree: {
        repo: 'acme/api',
        path,
        branch: `foedrum/12-1/${stepId}/1`,
        commit: 'c'.repeat(40),
      },
    },
  ];
  const plans = createAttemptPlans({
    state: () => fold(events),
    brewers: brewers(),
    models: { models: { builder: 'claude-sonnet-5-5' }, brewers: {} },
    repoTools: () => [],
    clone: (repo) => join('/clones', repo),
    sandbox: false,
    workRoot: join('/root'),
    env: { base: { PATH: '/usr/bin' }, forced: {} },
    platform: 'linux',
    orderText: async () => 'Save the page under its title.',
    git: async () => ({ code: 0, stdout: '', stderr: '' }),
    files: { read: () => ({ kind: 'missing' }), makeFolder: () => {} },
    random: () => Buffer.from('0123456789abcdef0123456789abcdef', 'hex'),
  });
  const { prompt } = await plans.plan({
    ref,
    limits: { outDoc: { file: 'out.md', schema: OutDocFrontmatter } },
  });
  return prompt;
};

describe('a sub-order without a security mark (ADR 0322)', () => {
  it('reads as before in its section and its plan entry: regression test', () => {
    const plan = done(subOrder('writer'));
    const report = planOf(plan);
    assert.ok(report);
    const section = [
      '#### `writer`: Build writer',
      '',
      '- Builds in acme/api: one writer, about 120 lines',
      '- Done when: the writer saves the page',
      '- Recipe `nip`: a test pins it',
    ];
    const touches = [
      '',
      '<details><summary>Touches 1 path</summary>',
      '',
      '- src/writer.ts',
      '',
      '</details>',
    ];
    assert.ok(renderPlan('7-1', 'plan', report).includes([...section, ...touches].join('\n')));
    assert.equal(
      planEntryText(fold(planned(plan)), origin),
      [...section, '- Depends on: none', ...touches].join('\n'),
    );
  });

  it('an approved older plan without the field still gives its sub-order its entry: regression test', async () => {
    const prompt = await promptOf('security', done(subOrder('writer')));
    assert.match(
      prompt,
      /source="entry writer of the plan of batch 7-1, step plan#1" name="planEntry">\n#### `writer`: Build writer\n[\s\S]*- Done when: the writer saves the page\n/,
    );
    assert.doesNotMatch(prompt, /- Security:/);
  });
});
