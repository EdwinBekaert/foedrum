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

const setup = (
  events: Event[] = [...ordered, started],
  files: Record<string, OutDocRead> = {},
  orderBody = 'Add a --json flag.',
) => {
  const folders: string[] = [];
  const reads: { file: string; root: string }[] = [];
  const sizes: number[] = [];
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
      return orderBody;
    },
    files: {
      read: (file, maxBytes, root) => {
        reads.push({ file, root });
        sizes.push(maxBytes);
        return files[file] ?? { kind: 'text', text: '# Guide' };
      },
      makeFolder: (path) => folders.push(path),
    },
    sessionId: () => sessionId,
    random: () => Buffer.from('0123456789abcdef0123456789abcdef', 'hex'),
  });
  return { plans, folders, reads, sizes, orders };
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

  it("gives a fresh attempt the answers to its step's questions as an in-doc, after the inputs (ADR 0006)", async () => {
    const answered: Event = {
      type: 'input.received',
      batchId: '12-1',
      stepId: 'brew',
      by: 'octocat',
      via: 'terminal',
      answers: [
        { q: 'Which flag?', answer: '--json' },
        { q: 'Also for status?', answer: 'yes' },
      ],
    };
    const { plans } = setup([...ordered, answered, started]);
    const { prompt } = await plans.plan(start);
    assert.match(
      prompt,
      /source="file docs\/guide\.md" name="guide">[\s\S]*source="answers to the questions of step brew" name="answers">\nQ: Which flag\?\nA: --json\n\nQ: Also for status\?\nA: yes\n<\//,
    );
  });

  it("throws, naming the input, when the order's text is larger than 1 MiB (review of #165)", async () => {
    const { plans } = setup(undefined, {}, 'x'.repeat(1024 * 1024 + 1));
    await assert.rejects(
      plans.plan(start),
      /the input "order" was not read: it is larger than 1048576 bytes/,
    );
    // At the limit it is read.
    const { plans: atLimit } = setup(undefined, {}, 'é'.repeat(512 * 1024));
    assert.match((await atLimit.plan(start)).prompt, /name="order">\né/);
  });

  it('reads an input file of at most 1 MiB (review of #165)', async () => {
    const { plans, sizes } = setup();
    await plans.plan(start);
    assert.deepEqual(sizes, [1024 * 1024]);
  });

  it('asks for no sandbox when the isolation level does not rely on it (review of #165)', async () => {
    const { plans } = setup();
    assert.equal((await plans.plan(start)).permissions.sandbox, false);
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

  it("takes the limits from the batch's own recipe when two recipes share a step id (review of #165)", () => {
    const two = loadRecipes({
      recipes: [
        { path: 'recipes/pale.jsonc', text: recipeText('pale', [{ id: 'brew', brewer: 'quick' }]) },
        {
          path: 'recipes/stout.jsonc',
          text: recipeText('stout', [{ id: 'brew', brewer: 'slow' }]),
        },
      ],
      brewers: [
        { path: 'brewers/quick.md', text: brewerText('quick', { maxTurns: 5 }) },
        { path: 'brewers/slow.md', text: brewerText('slow', { maxTurns: 50 }) },
      ],
    });
    assert.ok(two.valid);
    const routed = (batchId: string, recipe: string): Event[] => [
      { type: 'batch.ordered', batchId, order: { issue: 12 }, routeBy: '2026-10-17T13:00:00.000Z' },
      { type: 'batch.recipe_chosen', batchId, recipe, reason: 'label', source: 'label' },
    ];
    const events = [...routed('12-1', 'pale'), ...routed('13-1', 'stout')];
    const plans = createAttemptPlans({
      state: () => fold(events),
      brewers: two.brewers,
      models: { models: {}, brewers: {} },
      repoTools: () => [],
      sandbox: false,
      workRoot,
      env: { base: {}, forced: {} },
      orderText: async () => '',
    });
    const turns = (batchId: string) =>
      plans.limits({ batchId, stepId: 'brew', attempt: 1 }).maxTurns;
    assert.deepEqual([turns('12-1'), turns('13-1')], [5, 50]);
  });

  it('gives an attempt of a batch without a recipe the out doc of the contract alone', () => {
    const { plans } = setup([ordered[0] as Event]);
    assert.deepEqual(plans.limits(ref), { outDoc: { file: 'out.md', schema: OutDocFrontmatter } });
  });

  it("names the out doc of the brewer of a step in the batch's recipe, for the cleanup (ADR 0081)", () => {
    const { plans } = setup();
    assert.equal(plans.outDoc({ batchId: '12-1', stepId: 'brew' }), 'brew.md');
  });

  it('names no out doc for a step without a brewer, or a batch without a recipe (ADR 0081)', () => {
    assert.equal(setup().plans.outDoc({ batchId: '12-1', stepId: 'taste' }), undefined);
    assert.equal(setup().plans.outDoc({ batchId: '13-1', stepId: 'brew' }), undefined);
    const unrouted = setup([ordered[0] as Event]).plans;
    assert.equal(unrouted.outDoc({ batchId: '12-1', stepId: 'brew' }), undefined);
  });

  it('gives an attempt whose step has no brewer the out doc of the contract alone: its plan fails', () => {
    const { plans } = setup();
    assert.deepEqual(plans.limits({ ...ref, stepId: 'taste' }), {
      outDoc: { file: 'out.md', schema: OutDocFrontmatter },
    });
  });
});
