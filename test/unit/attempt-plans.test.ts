// The attempt plans' shell (#148, ADR 0059): for the attempt the driver started, it finds the
// brewer of its step in the batch's recipe, reads the brewer's inputs and makes the folder of the
// settings file, then plans the attempt in the session the driver recorded. The files, the order's
// text and the ids are fakes.

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
  // The session the driver chose for the attempt (ADR 0116).
  session: { id: sessionId, worktree },
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
  brewers = loaded.brewers,
) => {
  const folders: string[] = [];
  const reads: { file: string; root: string }[] = [];
  const sizes: number[] = [];
  const orders: unknown[] = [];
  const plans = createAttemptPlans({
    state: () => fold(events),
    brewers,
    models: { models: { builder: 'claude-sonnet-5-5' }, brewers: {} },
    repoTools: (repo) => (repo === 'acme/api' ? ['Bash(npm test)'] : []),
    clone: (repo) => join('/clones', repo),
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
    random: () => Buffer.from('0123456789abcdef0123456789abcdef', 'hex'),
  });
  return { plans, folders, reads, sizes, orders };
};
const start = { ref, limits: { outDoc: { file: 'brew.md', schema: OutDocFrontmatter } } };

describe('createAttemptPlans: plan', () => {
  it('puts the text of a lens input in the prompt, tagged with the lens and its file (ADR 0098)', async () => {
    const withLens = loadRecipes({
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
            inputs: [{ name: 'focus', from: 'lens:test-design' }],
          }),
        },
      ],
      defaults: {
        lenses: [{ path: 'defaults/lenses/test-design.md', text: '# Lens: test design\n' }],
      },
    });
    assert.ok(withLens.valid, withLens.valid ? '' : withLens.problems.join('\n'));
    const { plans, reads } = setup(undefined, {}, undefined, withLens.brewers);
    const { prompt } = await plans.plan(start);
    assert.match(
      prompt,
      /source="lens test-design, file defaults\/lenses\/test-design\.md" name="focus">\n# Lens: test design\n\n<\//,
    );
    // The lens was read with the brewer: nothing more is read for it.
    assert.deepEqual(reads, []);
  });

  it("plans the attempt in the worktree and the session the driver recorded, with the repository's tools", async () => {
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

  it('gives an attempt an onBlocked route scheduled the out doc that blocked, last (#341, ADR 0128)', async () => {
    const routing = loadRecipes({
      recipes: [
        {
          path: 'recipes/pale.jsonc',
          text: recipeText('pale', [
            { id: 'brew', brewer: 'brewmaster' },
            {
              id: 'taste',
              brewer: 'brewmaster',
              onBlocked: { findings: { goto: 'brew', maxRounds: 1 } },
            },
          ]),
        },
      ],
      brewers: [
        {
          path: 'brewers/brewmaster.md',
          text: brewerText('brewmaster', {
            output: { doc: 'brew.md', schema: 'outDoc' },
            tools: { allow: ['Read', 'Write'] },
            inputs: [{ name: 'order', from: 'order' }],
          }),
        },
      ],
    });
    assert.ok(routing.valid, routing.valid ? '' : routing.problems.join('\n'));
    const deadlineAt = '2026-10-17T13:00:00.000Z';
    const tasteTree = join('/work', 'taste-1');
    const taste = { batchId: '12-1', stepId: 'taste', attempt: 1 };
    const second = { ...ref, attempt: 2 };
    const events: Event[] = [
      ...ordered,
      started,
      { type: 'step.finished', ...ref, outcome: { kind: 'succeeded', output: null } },
      { type: 'step.scheduled', ...taste, deadlineAt },
      {
        type: 'step.started',
        ...taste,
        worktree: {
          repo: 'acme/api',
          path: tasteTree,
          branch: 'foedrum/12-1/taste/1',
          commit: 'c'.repeat(40),
        },
      },
      {
        type: 'step.finished',
        ...taste,
        outcome: { kind: 'failed', retryable: false, reason: 'blocked (findings): Too bitter' },
      },
      { type: 'step.scheduled', ...second, deadlineAt, route: { from: 'taste', why: 'findings' } },
      { ...started, attempt: 2 },
    ];
    const doc = '---\n{ "status": "blocked" }\n---\nHalve the hops.';
    const blocked = { [join(tasteTree, 'brew.md')]: { kind: 'text', text: doc } } as const;
    const { plans, reads, sizes } = setup(events, blocked, undefined, routing.brewers);
    const { prompt } = await plans.plan({ ...start, ref: second });
    assert.deepEqual(reads.at(-1), { file: join(tasteTree, 'brew.md'), root: tasteTree });
    assert.equal(sizes.at(-1), 1024 * 1024);
    assert.match(
      prompt,
      /name="order">[\s\S]*source="why step brew runs again: the findings of step taste" name="route">\n[^<]*Too bitter[\s\S]*Halve the hops\.\n<\/untrusted-input-[0-9a-f]+>$/,
    );
  });

  it('gives an attempt an onFail route scheduled the failed reading, last, reading no file for it (#341, ADR 0128)', async () => {
    const deadlineAt = '2026-10-17T13:00:00.000Z';
    const green = { batchId: '12-1', stepId: 'green', attempt: 1 };
    const second = { ...ref, attempt: 2 };
    const events: Event[] = [
      ...ordered,
      started,
      { type: 'step.finished', ...ref, outcome: { kind: 'succeeded', output: null } },
      { type: 'step.scheduled', ...green, deadlineAt },
      {
        type: 'step.started',
        ...green,
        worktree: {
          repo: 'acme/api',
          path: join('/work', 'green-1'),
          branch: 'foedrum/12-1/green/1',
          commit: 'c'.repeat(40),
        },
      },
      {
        type: 'step.finished',
        ...green,
        outcome: {
          kind: 'failed',
          retryable: false,
          reason: 'the check "test" (npm test) failed with exit code 1',
        },
        readings: [
          {
            result: 'exited',
            check: 'test',
            command: 'npm test',
            exitCode: 1,
            tail: 'not ok 2 - prints --json',
          },
        ],
      },
      { type: 'step.scheduled', ...second, deadlineAt, route: { from: 'green', why: 'failed' } },
      { ...started, attempt: 2 },
    ];
    const { plans, reads } = setup(events);
    const { prompt } = await plans.plan({ ...start, ref: second });
    // The guide input only: the reading is in the event log.
    assert.deepEqual(reads, [{ file: join(worktree, 'docs', 'guide.md'), root: worktree }]);
    assert.match(
      prompt,
      /name="guide">[\s\S]*source="why step brew runs again: the failed checks of step green" name="route">\nStep green ended: the check "test" \(npm test\) failed with exit code 1[\s\S]*not ok 2 - prints --json\n<\/untrusted-input-[0-9a-f]+>$/,
    );
  });

  describe('a resumed attempt (ADR 0117)', () => {
    const deadlineAt = '2026-10-17T13:00:00.000Z';
    const second = { ...ref, attempt: 2 };
    const recreated = join('/work', 'brew-1-again');
    const failed: Event = {
      type: 'step.finished',
      ...ref,
      outcome: { kind: 'failed', retryable: true, reason: 'claude crashed' },
      claude: { version: '2.1.301', model: 'claude-sonnet-5-5' },
    };
    const resumed: Event = {
      type: 'step.started',
      ...second,
      // Where the driver recreated the worktree, which need not be where it was made.
      session: { id: sessionId, resumes: sessionId, worktree: recreated },
    };

    it('resumes its session with --resume in the worktree it continues, told to go on, reading no input', async () => {
      const events: Event[] = [
        ...ordered,
        started,
        failed,
        { type: 'step.scheduled', ...second, deadlineAt, retry: true },
        resumed,
      ];
      const { plans, reads, orders } = setup(events);
      const plan = await plans.plan({ ...start, ref: second });
      assert.equal(plan.cwd, recreated);
      assert.deepEqual(plan.call.session, { kind: 'resume', id: sessionId });
      assert.equal(plan.call.model, 'claude-sonnet-5-5');
      assert.deepEqual(plan.permissions.allow, ['Read', 'Write', 'Bash(npm test)']);
      assert.deepEqual(reads, [], 'the session holds its inputs');
      assert.deepEqual(orders, []);
      assert.match(
        plan.prompt,
        /^The run before this one ended before the step was done\. Go on with the step where it stopped, then write brew\.md as your instructions say\./,
      );
      assert.doesNotMatch(plan.prompt, /untrusted-input/);
    });

    // The answers to the questions of brew#1, and of an earlier round, which its session holds.
    const received = (q: string, answer: string): Event => ({
      type: 'input.received',
      batchId: '12-1',
      stepId: 'brew',
      by: 'octocat',
      via: 'terminal',
      answers: [{ q, answer }],
    });
    const question = { options: ['a', 'b'], recommended: 'a', whyBlocking: 'It decides' };
    const asked: Event = {
      type: 'step.finished',
      ...ref,
      outcome: { kind: 'needs_input', questions: [{ q: 'Which flag?', ...question }] },
      claude: { version: '2.1.301', model: 'claude-sonnet-5-5' },
    };

    it("resumes the session of an answered attempt with this round's answers alone (#327, ADR 0118)", async () => {
      const events: Event[] = [
        ...ordered,
        // An earlier round, which the session already holds.
        received('Which file?', 'cli.ts'),
        started,
        asked,
        received('Which flag?', '--json'),
        { type: 'step.scheduled', ...second, deadlineAt, answered: true },
        resumed,
      ];
      const { plans, reads, orders } = setup(events);
      const plan = await plans.plan({ ...start, ref: second });
      assert.equal(plan.cwd, recreated);
      assert.deepEqual(plan.call.session, { kind: 'resume', id: sessionId });
      assert.deepEqual(reads, [], 'the session holds its inputs');
      assert.deepEqual(orders, []);
      assert.match(
        plan.prompt,
        /^A human answered the questions the run before this one asked\. Go on with the step where it stopped, with the answers below, then write brew\.md as your instructions say\./,
      );
      assert.match(
        plan.prompt,
        /source="answers to the questions of step brew" name="answers">\nQ: Which flag\?\nA: --json\n<\//,
      );
      assert.doesNotMatch(plan.prompt, /Which file\?/);
    });

    it('gives a fresh retry after a resume that found no session every round of answers (ADR 0118)', async () => {
      const third = { ...ref, attempt: 3 };
      const own = join('/work', 'brew-3');
      const reason = 'claude could not resume the session: No conversation found';
      const events: Event[] = [
        ...ordered,
        received('Which file?', 'cli.ts'),
        started,
        asked,
        received('Which flag?', '--json'),
        { type: 'step.scheduled', ...second, deadlineAt, answered: true },
        resumed,
        // It ended before claude's init: no report, so its retry starts fresh (ADR 0117).
        { type: 'step.finished', ...second, outcome: { kind: 'failed', retryable: true, reason } },
        { type: 'step.scheduled', ...third, deadlineAt, retry: true },
        {
          type: 'step.started',
          ...third,
          session: {
            id: sessionId,
            worktree: own,
            fallback: 'brew#2 has no session claude started',
          },
          worktree: {
            repo: 'acme/api',
            path: own,
            branch: 'foedrum/12-1/brew/3',
            commit: 'c'.repeat(40),
          },
        },
      ];
      const { plans } = setup(events);
      const plan = await plans.plan({ ...start, ref: third });
      assert.equal(plan.cwd, own);
      assert.deepEqual(plan.call.session, { kind: 'new', id: sessionId });
      assert.match(
        plan.prompt,
        /name="answers">\nQ: Which file\?\nA: cli\.ts\n\nQ: Which flag\?\nA: --json\n<\//,
      );
    });
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

  it('throws when the driver recorded no session for the attempt (ADR 0116)', async () => {
    const { session: _, ...unrecorded } = started as Extract<Event, { type: 'step.started' }>;
    const { plans } = setup([...ordered, unrecorded]);
    await assert.rejects(plans.plan(start), /attempt brew#1 of batch 12-1 has no session/);
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
      clone: () => join('/clones', 'acme/api'),
      sandbox: false,
      workRoot,
      env: { base: {}, forced: {} },
      orderText: async () => '',
    });
    const turns = (batchId: string) =>
      plans.limits({ batchId, stepId: 'brew', attempt: 1 }).maxTurns;
    assert.deepEqual([turns('12-1'), turns('13-1')], [5, 50]);
  });

  it('gives an attempt of a brewer that produces commits the commit its worktree started at, and its plan where to count (ADR 0074)', async () => {
    const committing = loadRecipes({
      recipes: [
        {
          path: 'recipes/pale.jsonc',
          text: recipeText(
            'pale',
            [{ id: 'brew', brewer: 'cellarman' }, { action: 'openPullRequest' }],
            {
              testFirst: false,
            },
          ),
        },
      ],
      brewers: [
        {
          path: 'brewers/cellarman.md',
          text: brewerText('cellarman', {
            produces: 'commits',
            access: 'write',
            git: { commit: true },
            tools: { allow: ['Read', 'Write'] },
          }),
        },
      ],
    });
    assert.ok(committing.valid, committing.valid ? '' : committing.problems.join('\n'));
    const plans = (events: Event[]) =>
      createAttemptPlans({
        state: () => fold(events),
        brewers: committing.brewers,
        models: { models: { builder: 'claude-sonnet-5-5' }, brewers: {} },
        repoTools: () => [],
        clone: (repo) => join('/clones', repo),
        sandbox: false,
        workRoot,
        env: { base: {}, forced: {} },
        orderText: async () => '',
        files: { read: () => ({ kind: 'missing' }), makeFolder: () => {} },
      });
    // The attempt's branch in the clone its worktree was added to: what the push takes, which
    // nothing the brewer writes in its worktree can redirect (review of #208).
    assert.deepEqual((await plans([...ordered, started]).plan(start)).commits, {
      clone: join('/clones', 'acme/api'),
      branch: 'foedrum/12-1/brew/1',
    });
    assert.deepEqual(plans([...ordered, started]).limits(ref), {
      outDoc: { file: 'out.md', schema: OutDocFrontmatter },
      commitsSince: 'c'.repeat(40),
    });
    // Not started yet: no worktree, so nothing to count from; its plan fails before it runs.
    assert.deepEqual(plans(ordered).limits(ref), {
      outDoc: { file: 'out.md', schema: OutDocFrontmatter },
    });
    // A resumed attempt commits on the branch of the worktree it continues, counted from where
    // that worktree started (ADR 0117).
    const second = { ...ref, attempt: 2 };
    const resumed: Event[] = [
      ...ordered,
      started,
      {
        type: 'step.finished',
        ...ref,
        outcome: { kind: 'failed', retryable: true, reason: 'claude crashed' },
        claude: { version: '2.1.301', model: 'claude-sonnet-5-5' },
      },
      { type: 'step.scheduled', ...second, deadlineAt: '2026-10-17T13:00:00.000Z', retry: true },
      {
        type: 'step.started',
        ...second,
        session: { id: sessionId, resumes: sessionId, worktree },
      },
    ];
    assert.deepEqual((await plans(resumed).plan({ ...start, ref: second })).commits, {
      clone: join('/clones', 'acme/api'),
      branch: 'foedrum/12-1/brew/1',
    });
    assert.deepEqual(plans(resumed).limits(second), {
      outDoc: { file: 'out.md', schema: OutDocFrontmatter },
      commitsSince: 'c'.repeat(40),
    });
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
