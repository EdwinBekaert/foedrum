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
    outcome: { kind: 'succeeded', output: JSON.parse(JSON.stringify(plan)) },
  },
  {
    type: 'batch.approved',
    batchId: '7-1',
    stepId: 'plan',
    attempt: 1,
    plan: '0123456789abcdef',
    by: 'ann',
    via: 'terminal',
    at,
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

describe("a sub-order's security mark (ADR 0322)", () => {
  it("a sub-order's security mark is read from a plan, and a plan without it reads as before", () => {
    const marked = subOrder('writer', { securityMark });
    const report = planOf(done(marked, subOrder('reader')));
    assert.deepEqual(report?.subOrders, [marked, subOrder('reader')]);
  });

  it('a plan that turns test-first off for a marked sub-order is refused, naming both', () => {
    const off = { testFirst: false, testFirstOff: 'prose only' };
    const read = readOutDoc(
      `---\n${JSON.stringify(done(subOrder('writer', { securityMark, ...off })))}\n---\n# Plan\n`,
      PlanOutDoc,
    );
    assert.equal(read.valid, false);
    const reason = read.valid ? '' : read.reason;
    assert.match(reason, /securityMark/);
    assert.match(reason, /testFirst/);
  });

  it('a mark is one line of at most 300 characters, and not empty: regression test', () => {
    const reasonOf = (mark: string): string | undefined => {
      const plan = done(subOrder('writer', { securityMark: mark }));
      const read = readOutDoc(`---\n${JSON.stringify(plan)}\n---\n# Plan\n`, PlanOutDoc);
      return read.valid ? undefined : read.reason;
    };
    assert.equal(reasonOf('m'.repeat(300)), undefined);
    for (const mark of ['m'.repeat(301), 'one\ntwo', '']) {
      assert.match(reasonOf(mark) ?? '', /subOrders\[0\]\.securityMark/, JSON.stringify(mark));
    }
  });

  it("a marked sub-order's plan entry shows its mark, escaped as the entry's other text", () => {
    const hostile = 'the @team <b>title</b> reaches [a path](x) `rm`';
    const plan = done(subOrder('writer', { securityMark: hostile, doneWhen: hostile }));
    const report = planOf(plan);
    assert.ok(report, 'a plan with a mark reads');
    const entry = planEntryText(fold(planned(plan)), origin);
    const comment = renderPlan('7-1', 'plan', report);
    for (const text of [entry, comment]) {
      const shown = /\n- Done when: (.*)\n/.exec(text)?.[1];
      assert.ok(shown);
      assert.ok(!shown.includes('@team'));
      assert.ok(text.includes(`\n- Recipe \`nip\`: a test pins it\n- Security: ${shown}\n`), text);
    }
  });

  it('a secret in a mark is left out of the plan entry', () => {
    // Built at run time, so no scanner takes this file for one that holds a token.
    const token = ['ghp', 'A1b2'.repeat(9)].join('_');
    const plan = done(subOrder('writer', { securityMark: `it reads ${token}` }));
    const entry = planEntryText(fold(planned(plan)), origin);
    assert.ok(!entry.includes(token));
    assert.match(
      entry,
      /- Security: \\\[left out: a text of step plan that looks like a secret\\\]/,
    );
  });

  it("a marked sub-order's Taster prompt shows the mark in its planEntry input", async () => {
    const prompt = await promptOf('security', done(subOrder('writer', { securityMark })));
    assert.match(
      prompt,
      /name="planEntry">\n#### `writer`: Build writer\n[\s\S]*- Security: the issue's title reaches the file path the writer saves to\n[\s\S]*<\/untrusted-input-/,
    );
  });

  it('the diff security lens says to check what the mark in its plan entry names', async () => {
    const prompt = await promptOf('security', done(subOrder('writer')));
    assert.match(prompt, /`Security` line[\s\S]*Check what the mark names first/);
    assert.match(prompt, /no such line[^\n]*never means/);
  });

  it("the Gauger's prompt says to pin the mark in a test", () => {
    assert.match(instructionsOf('gauge'), /`Security` line[^\n]*pin what the mark names in a test/);
  });

  it("the Cellarman's prompt says to hold what the mark names in its code", () => {
    assert.match(instructionsOf('implement'), /`Security` line[^\n]*hold what the mark names/);
  });

  it("the Brewmaster's prompt marks a sub-order by the plan lens's list", () => {
    const bullet = /^- \*\*A security mark\.\*\*.*$/m.exec(instructionsOf('plan', 'mash'))?.[0];
    assert.ok(bullet);
    for (const item of ['command', 'model', 'file path', 'token', 'dependency', '`securityMark`']) {
      assert.ok(bullet.includes(item), item);
    }
  });

  it('the plan security lens says when a sub-order that lets input in has no mark', () => {
    const lens = readFileSync(join(FOEDRUM_DEFAULTS, 'lenses', 'plan', 'security.md'), 'utf8');
    assert.match(lens, /no `securityMark`/);
  });
});
