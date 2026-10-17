// The attempt plans' shell (#148, ADR 0059): for the attempt the driver started, it finds the
// brewer of its step in the batch's recipe, reads the brewer's inputs and makes the folder of the
// settings file, then plans the attempt. The files, the order's text and the ids are fakes.

import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { createAttemptPlans } from '../../src/brewers/attempt-plans.ts';
import type { OutDocRead } from '../../src/brewers/claude-runner.ts';
import { fold } from '../../src/engine/fold.ts';
import { loadRecipes } from '../../src/engine/recipe-files.ts';
import type { Event } from '../../src/schemas/events.ts';
import { OutDocFrontmatter } from '../../src/schemas/out-doc.ts';
import { brewerText, recipeText } from '../helpers/brewery-files.ts';

const workRoot = join('/root');
const worktree = join('/work', 'brew-1');
const sessionId = '0f8fad5b-d9cb-469f-a165-70867728950e';
const ref = { batchId: '12-1', stepId: 'brew', attempt: 1 };

const loaded = loadRecipes({
  recipes: [
    {
      path: 'recipes/pale.jsonc',
      text: recipeText('pale', [{ id: 'brew', brewer: 'brewmaster' }]),
    },
  ],
  brewers: [
    {
      path: 'brewers/brewmaster.md',
      text: brewerText('brewmaster', {
        output: { doc: 'brew.md', schema: 'outDoc' },
        tools: { allow: ['Read', 'Write'] },
        maxTurns: 30,
        inputs: [
          { name: 'order', from: 'order' },
          { name: 'guide', from: 'file:docs/guide.md' },
        ],
      }),
    },
  ],
});
assert.ok(loaded.valid);

const ordered: Event[] = [
  {
    type: 'batch.ordered',
    batchId: '12-1',
    order: { issue: 12 },
    routeBy: '2026-10-17T13:00:00.000Z',
  },
  {
    type: 'batch.recipe_chosen',
    batchId: '12-1',
    recipe: 'pale',
    reason: 'label',
    source: 'label',
  },
  { type: 'step.scheduled', ...ref, deadlineAt: '2026-10-17T13:00:00.000Z' },
];
const started: Event = {
  type: 'step.started',
  ...ref,
  worktree: {
    repo: 'acme/api',
    path: worktree,
    branch: 'foedrum/12-1/brew/1',
    commit: 'c'.repeat(40),
  },
};

const setup = (events: Event[] = [...ordered, started], files: Record<string, OutDocRead> = {}) => {
  const folders: string[] = [];
  const reads: { file: string; root: string }[] = [];
  const orders: unknown[] = [];
  const plans = createAttemptPlans({
    state: () => fold(events),
    brewers: loaded.brewers,
    models: { models: { builder: 'claude-sonnet-5-5' }, brewers: {} },
    repoTools: (repo) => (repo === 'acme/api' ? ['Bash(npm test)'] : []),
    sandbox: false,
    workRoot,
    env: { base: { PATH: '/usr/bin' }, forced: { npm_config_ignore_scripts: 'true' } },
    platform: 'linux',
    orderText: async (order) => {
      orders.push(order);
      return 'Add a --json flag.';
    },
    files: {
      read: (file, _maxBytes, root) => {
        reads.push({ file, root });
        return files[file] ?? { kind: 'text', text: '# Guide' };
      },
      makeFolder: (path) => folders.push(path),
    },
    sessionId: () => sessionId,
    random: () => Buffer.from('0123456789abcdef0123456789abcdef', 'hex'),
  });
  return { plans, folders, reads, orders };
};
const start = { ref, limits: { outDoc: { file: 'brew.md', schema: OutDocFrontmatter } } };

describe('createAttemptPlans: plan', () => {
  it("plans the attempt in the worktree the driver recorded, with the repository's tools", async () => {
    const { plans } = setup();
    const plan = await plans.plan(start);
    assert.equal(plan.cwd, worktree);
    assert.deepEqual(plan.call.session, { kind: 'new', id: sessionId });
    assert.equal(plan.call.model, 'claude-sonnet-5-5');
    assert.deepEqual(plan.permissions.allow, ['Read', 'Write', 'Bash(npm test)']);
    assert.deepEqual(plan.env, { PATH: '/usr/bin', npm_config_ignore_scripts: 'true' });
  });

  it("reads the order's text and the file input inside the worktree, and prompts with both", async () => {
    const { plans, reads, orders } = setup();
    const { prompt } = await plans.plan(start);
    assert.deepEqual(orders, [{ kind: 'order', issue: 12 }]);
    assert.deepEqual(reads, [{ file: join(worktree, 'docs', 'guide.md'), root: worktree }]);
    assert.match(prompt, /source="issue #12 body" name="order">\nAdd a --json flag\.\n/);
    assert.match(prompt, /source="file docs\/guide\.md" name="guide">\n# Guide\n/);
  });

  it('makes the folder of the settings file under the work root', async () => {
    const { plans, folders } = setup();
    const plan = await plans.plan(start);
    assert.equal(plan.settingsFile, join(workRoot, 'attempt-settings', '12-1', 'brew', '1.json'));
    assert.deepEqual(folders, [dirname(plan.settingsFile)]);
  });

  it('throws when the attempt has no worktree', async () => {
    const { plans } = setup([...ordered, { type: 'step.started', ...ref }]);
    await assert.rejects(plans.plan(start), /attempt brew#1 of batch 12-1 has no worktree/);
  });

  it('throws when the step left its recipe', async () => {
    const { plans } = setup([
      ...ordered.map((event) =>
        event.type === 'batch.recipe_chosen' ? { ...event, recipe: 'stout' } : event,
      ),
      started,
    ]);
    await assert.rejects(plans.plan(start), /recipe stout has no step brew/);
  });

  for (const [what, read, reason] of [
    ['is missing', { kind: 'missing' }, 'it is missing'],
    [
      'is not read',
      { kind: 'unread', reason: 'it is outside the worktree' },
      'it is outside the worktree',
    ],
  ] as const) {
    it(`throws, naming the input, when its file ${what}`, async () => {
      const { plans } = setup(undefined, { [join(worktree, 'docs', 'guide.md')]: read });
      await assert.rejects(
        plans.plan(start),
        new RegExp(`the input "guide" was not read: ${reason}`),
      );
    });
  }
});

describe('createAttemptPlans: limits', () => {
  it("gives an attempt the limits of the brewer of its step in the batch's recipe", () => {
    const { plans } = setup();
    assert.deepEqual(plans.limits(ref), {
      outDoc: { file: 'brew.md', schema: OutDocFrontmatter },
      maxTurns: 30,
    });
  });

  it('gives an attempt whose step has no brewer the out doc of the contract alone: its plan fails', () => {
    const { plans } = setup();
    assert.deepEqual(plans.limits({ ...ref, stepId: 'taste' }), {
      outDoc: { file: 'out.md', schema: OutDocFrontmatter },
    });
  });
});
