// The attempt plans' shell (#148, ADR 0059): for the attempt the driver started, it finds the
// brewer of its step in the batch's recipe, reads the brewer's inputs and makes the folder of the
// settings file, then plans the attempt in the session the driver recorded. The files, the order's
// text and the ids are fakes.

import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { type AttemptPlansOptions, createAttemptPlans } from '../../src/brewers/attempt-plans.ts';
import type { OutDocRead } from '../../src/brewers/claude-runner.ts';
import { baseMergeKey } from '../../src/engine/base-merge.ts';
import { effectKey } from '../../src/engine/effect-key.ts';
import { fold } from '../../src/engine/fold.ts';
import { loadRecipes } from '../../src/engine/recipe-files.ts';
import type { Event } from '../../src/schemas/events.ts';
import { GaugeOutDoc, OutDocFrontmatter } from '../../src/schemas/out-doc.ts';
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
  options: Partial<AttemptPlansOptions> = {},
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
    ...options,
  });
  return { plans, folders, reads, sizes, orders };
};
const start = { ref, limits: { outDoc: { file: 'brew.md', schema: OutDocFrontmatter } } };

describe('createAttemptPlans: plan', () => {
  it("plans an interactive step's session with the recipe's prompt and its prompt file (ADR 0222)", async () => {
    const interactive = { prompt: 'Plan it with me.' };
    const brewers = {
      find: (recipe: string, stepId: string) => {
        const found = loaded.brewers.find(recipe, stepId);
        return found && { ...found, interactive };
      },
    };
    const { plans } = setup(undefined, {}, undefined, brewers);
    const planned = await plans.plan(start);
    assert.match(planned.prompt, /Plan it with me\./);
    assert.equal(
      planned.interactive?.file,
      join(workRoot, 'attempt-settings', '12-1', 'brew', '1.prompt.md'),
    );
    const plain = await setup().plans.plan(start);
    assert.equal(plain.interactive, undefined);
  });

  it('puts the recipes a step that chooses may offer in its prompt, and holds its question to them (ADR 0232)', async () => {
    const choosing = loadRecipes({
      recipes: [
        {
          path: 'recipes/pale.jsonc',
          text: recipeText('pale', [{ id: 'brew', brewer: 'innkeeper', chooses: 'recipe' }]),
        },
        { path: 'recipes/stout.jsonc', text: recipeText('stout', [{ brewer: 'brewmaster' }]) },
        { path: 'recipes/ale.jsonc', text: recipeText('ale', [{ brewer: 'brewmaster' }]) },
      ],
      brewers: [
        {
          path: 'brewers/innkeeper.md',
          text: brewerText('innkeeper', {
            output: { doc: 'brew.md', schema: 'recipeChoice' },
            inputs: [{ name: 'recipes', from: 'recipes' }],
          }),
        },
        { path: 'brewers/brewmaster.md', text: brewerText('brewmaster') },
      ],
    });
    assert.ok(choosing.valid, choosing.valid ? '' : choosing.problems.join('\n'));
    const { plans } = setup(undefined, {}, undefined, choosing.brewers);
    const { prompt } = await plans.plan(start);
    // In the order the loader read them, each with its own description.
    assert.match(prompt, /name="recipes">\n- stout: The stout\.\n- ale: The ale\.\n\n<\//);
    const { schema } = plans.limits(ref).outDoc;
    const asking = (options: string[]) => ({
      status: 'needs_input',
      summary: 'A recipe to choose',
      questions: [{ q: 'Which?', options, recommended: 'stout', whyBlocking: 'It decides' }],
    });
    assert.equal(schema.safeParse(asking(['stout', 'ale'])).success, true);
    assert.equal(schema.safeParse(asking(['stout', 'porter'])).success, false);
  });

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
            inputs: [{ name: 'focus', from: 'lens:diff/test-design' }],
          }),
        },
      ],
      defaults: {
        lenses: [{ path: 'defaults/lenses/diff/test-design.md', text: '# Lens: test design\n' }],
      },
    });
    assert.ok(withLens.valid, withLens.valid ? '' : withLens.problems.join('\n'));
    const { plans, reads } = setup(undefined, {}, undefined, withLens.brewers);
    const { prompt } = await plans.plan(start);
    assert.match(
      prompt,
      /source="lens diff\/test-design, file defaults\/lenses\/diff\/test-design\.md" name="focus">\n# Lens: test design\n\n<\//,
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

  it('tells a fresh retry after the secret scan why, last, with its inputs (ADR 0187)', async () => {
    const second = { ...ref, attempt: 2 };
    const reason =
      "the attempt's commits hold what looks like a secret, or what the scan cannot read (ADR 0187): commit 0123456789ab, GitHub token in test/keys.test.ts";
    const events: Event[] = [
      ...ordered,
      started,
      {
        type: 'step.finished',
        ...ref,
        outcome: { kind: 'failed', retryable: true, reason, secrets: true },
      },
      { type: 'step.scheduled', ...second, deadlineAt: '2026-10-17T13:00:00.000Z', retry: true },
      { ...started, attempt: 2 },
    ];
    const { plans } = setup(events);
    const { prompt } = await plans.plan({ ...start, ref: second });
    assert.match(
      prompt,
      /name="guide">[\s\S]*source="why step brew runs again: the secret scan of brew#1">\nThe secret scan failed the attempt before this one, brew#1: the attempt's commits hold what looks like a secret[^\n]*GitHub token in test\/keys\.test\.ts\n\nThis attempt starts where that one started, without its commits\.[^\n]*\n<\/untrusted-input-[0-9a-f]+>$/,
    );
  });

  it("gives an input from repositories the Brewery's repositories with their bases, its own marked (ADR 0234)", async () => {
    const planning = loadRecipes({
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
            output: { doc: 'plan.md', schema: 'plan' },
            inputs: [{ name: 'repositories', from: 'repositories' }],
          }),
        },
      ],
    });
    assert.ok(planning.valid, planning.valid ? '' : planning.problems.join('\n'));
    const repositories = [
      { repo: 'acme/web', base: 'origin/develop' },
      { repo: 'acme/api', base: 'origin/main' },
    ];
    const git = async () => ({ code: 0, stdout: `${'d'.repeat(40)}\n`, stderr: '' });
    const { plans } = setup(undefined, {}, undefined, planning.brewers, { repositories, git });
    const { prompt } = await plans.plan(start);
    assert.match(
      prompt,
      /source="the Brewery's repositories" name="repositories">\nThe Brewery's repositories, each with the base its work starts from:\n- acme\/web, base origin\/develop\n- acme\/api, base origin\/main: this attempt's repository, the one in your worktree\n<\/untrusted-input-[0-9a-f]+>/,
    );
  });

  it('tells a fresh retry why the attempt before it failed, last, with its inputs (ADR 0248)', async () => {
    const second = { ...ref, attempt: 2 };
    const events: Event[] = [
      ...ordered,
      started,
      {
        type: 'step.finished',
        ...ref,
        outcome: { kind: 'failed', retryable: true, reason: 'invalid out doc: summary: Required' },
      },
      { type: 'step.scheduled', ...second, deadlineAt: '2026-10-17T13:00:00.000Z', retry: true },
      { ...started, attempt: 2 },
    ];
    const { plans } = setup(events);
    const { prompt } = await plans.plan({ ...start, ref: second });
    assert.match(
      prompt,
      /name="guide">[\s\S]*source="why step brew runs again: the failure of brew#1" name="retry">\nThe attempt before this one, brew#1, failed: invalid out doc: summary: Required\n<\/untrusted-input-[0-9a-f]+>$/,
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

    it('resumes its session with --resume in the worktree it continues, told to go on, reading no input but why it runs again (ADR 0248)', async () => {
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
      // Its one input: why the attempt before it failed (ADR 0248).
      assert.match(
        plan.prompt,
        /instructions say\.[\s\S]*source="why step brew runs again: the failure of brew#1" name="retry">\nThe attempt before this one, brew#1, failed: claude crashed\n<\/untrusted-input-[0-9a-f]+>$/,
      );
      assert.equal(plan.prompt.match(/source="/g)?.length, 1);
      // Its out doc goes before the run, so the run is read by what it writes (ADR 0118).
      assert.equal(plan.outDocFrom, undefined);
    });

    it('tells a resumed fix the files its kept merge still has unmerged (ADR 0244)', async () => {
      const pullRequest = 'https://github.com/acme/api/pull/12';
      const route = {
        from: 'open',
        why: 'pull_request',
        pullRequest,
        head: 'd'.repeat(40),
        cause: 'conflict',
        tip: 'e'.repeat(40),
      } as const;
      const kept = {
        base: 'e'.repeat(40),
        kept: { files: [{ path: 'src/a.ts', status: 'both modified' }], more: 0 },
      };
      const events: Event[] = [
        ...ordered.slice(0, 2),
        { type: 'step.scheduled', ...ref, deadlineAt, route },
        started,
        failed,
        { type: 'step.scheduled', ...second, deadlineAt, retry: true },
        resumed,
        {
          type: 'pull_request.base_checked',
          batchId: '12-1',
          pullRequest,
          branch: 'main',
          tip: 'e'.repeat(40),
          head: 'd'.repeat(40),
          conflicts: ['src/a.ts'],
        },
        { type: 'effect.applied', key: effectKey.encode(baseMergeKey(second)), result: kept },
      ];
      const plan = await setup(events).plans.plan({ ...start, ref: second });
      assert.match(
        plan.prompt,
        /source="the merge of main in progress in the worktree of step brew"[^>]*>\nThe merge of main at e{40} is still in progress in this worktree\. These files are still unmerged:\n- src\/a\.ts \(both modified\)\n/,
      );
    });

    it('gives a retry of a routed fix what sent it back and why the attempt before it failed, once each (ADR 0244, ADR 0248)', async () => {
      const pullRequest = 'https://github.com/acme/api/pull/12';
      const route = {
        from: 'open',
        why: 'pull_request',
        pullRequest,
        head: 'd'.repeat(40),
        cause: 'conflict',
        tip: 'e'.repeat(40),
      } as const;
      const kept = {
        base: 'e'.repeat(40),
        kept: { files: [{ path: 'src/a.ts', status: 'both modified' }], more: 0 },
      };
      const checked: Event = {
        type: 'pull_request.base_checked',
        batchId: '12-1',
        pullRequest,
        branch: 'main',
        tip: 'e'.repeat(40),
        head: 'd'.repeat(40),
        conflicts: ['src/a.ts'],
      };
      const before: Event[] = [
        ...ordered.slice(0, 2),
        { type: 'step.scheduled', ...ref, deadlineAt, route },
        started,
        failed,
        { type: 'step.scheduled', ...second, deadlineAt, retry: true },
      ];
      const merged: Event = {
        type: 'effect.applied',
        key: effectKey.encode(baseMergeKey(second)),
        result: kept,
      };
      const count = (text: string, part: string) => text.split(part).length - 1;
      const conflict = `source="why step brew runs again: the conflict of pull request ${pullRequest} with main"`;
      const failure = 'source="why step brew runs again: the failure of brew#1"';
      const merging = 'source="the merge of main in progress in the worktree of step brew"';
      // A fresh retry, in a worktree of its own.
      const fresh: Event = {
        type: 'step.started',
        ...second,
        session: { id: sessionId, worktree: recreated },
        worktree: {
          repo: 'acme/api',
          path: recreated,
          branch: 'foedrum/12-1/brew/2',
          commit: 'c'.repeat(40),
        },
      };
      const freshPlan = await setup([...before, fresh, checked, merged]).plans.plan({
        ...start,
        ref: second,
      });
      assert.deepEqual(
        [conflict, failure, merging].map((part) => count(freshPlan.prompt, part)),
        [1, 1, 0],
      );
      // A retry that resumes the session.
      const resumedPlan = await setup([...before, resumed, checked, merged]).plans.plan({
        ...start,
        ref: second,
      });
      assert.deepEqual(
        [conflict, failure, merging].map((part) => count(resumedPlan.prompt, part)),
        [0, 1, 1],
      );
    });

    // ADR 0175: whatever the brewer's retryMode, the driver resumed it; the plan says why.
    it('tells a retry after a turn overrun to finish and end, and names the copy of the out doc it left', async () => {
      const overran: Event = {
        ...failed,
        outcome: {
          kind: 'failed',
          retryable: true,
          reason: 'budget exceeded: 41 turns, maxTurns is 40',
          overran: 'turns',
        },
      };
      const events: Event[] = [
        ...ordered,
        started,
        overran,
        { type: 'step.scheduled', ...second, deadlineAt, retry: true },
        resumed,
      ];
      const { plans, reads } = setup(events);
      const plan = await plans.plan({ ...start, ref: second });
      assert.equal(plan.cwd, recreated);
      assert.deepEqual(plan.call.session, { kind: 'resume', id: sessionId });
      assert.deepEqual(reads, [], 'the session holds its inputs');
      assert.match(
        plan.prompt,
        /^The run before this one ran out of turns\. Finish what is left of the step, write brew\.md as your instructions say, and end\.$/,
      );
      assert.equal(
        plan.outDocFrom,
        join(workRoot, 'attempt-settings', '12-1', 'brew', '1.out.md'),
        "the copy brew#1's runner kept",
      );
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

    it('gives a resumed retry after an answered round no answers: its session holds them (ADR 0118)', async () => {
      const third = { ...ref, attempt: 3 };
      const events: Event[] = [
        ...ordered,
        started,
        asked,
        received('Which flag?', '--json'),
        { type: 'step.scheduled', ...second, deadlineAt, answered: true },
        resumed,
        // brew#2 got claude's init, then crashed: its retry resumes the same session.
        {
          type: 'step.finished',
          ...second,
          outcome: { kind: 'failed', retryable: true, reason: 'claude crashed' },
          claude: { version: '2.1.301', model: 'claude-sonnet-5-5' },
        },
        { type: 'step.scheduled', ...third, deadlineAt, retry: true },
        {
          type: 'step.started',
          ...third,
          session: { id: sessionId, resumes: sessionId, worktree: recreated },
        },
      ];
      const { plans } = setup(events);
      const plan = await plans.plan({ ...start, ref: third });
      assert.deepEqual(plan.call.session, { kind: 'resume', id: sessionId });
      assert.match(plan.prompt, /^The run before this one ended before the step was done\./);
      assert.doesNotMatch(plan.prompt, /Which flag/);
      assert.match(plan.prompt, /The attempt before this one, brew#2, failed: claude crashed/);
    });

    it("starts an answered attempt that fell back fresh with the brewer's inputs and every round's answers (ADR 0118)", async () => {
      const own = join('/work', 'brew-2');
      const events: Event[] = [
        ...ordered,
        received('Which file?', 'cli.ts'),
        started,
        asked,
        received('Which flag?', '--json'),
        { type: 'step.scheduled', ...second, deadlineAt, answered: true },
        {
          type: 'step.started',
          ...second,
          session: {
            id: sessionId,
            worktree: own,
            fallback: 'the worktree of brew#1 could not be recreated: gone',
          },
          worktree: {
            repo: 'acme/api',
            path: own,
            branch: 'foedrum/12-1/brew/2',
            commit: 'c'.repeat(40),
          },
        },
      ];
      const { plans, orders } = setup(events);
      const plan = await plans.plan({ ...start, ref: second });
      assert.deepEqual(plan.call.session, { kind: 'new', id: sessionId });
      assert.equal(orders.length, 1, "it reads the order's text");
      assert.match(plan.prompt, /name="guide">/);
      assert.match(
        plan.prompt,
        /name="answers">\nQ: Which file\?\nA: cli\.ts\n\nQ: Which flag\?\nA: --json\n<\//,
      );
    });

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
      assert.equal(plan.outDocFrom, undefined, 'the needs_input it left goes (ADR 0118)');
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

  // ADR 0160: the settings hide the logins where the driver's environment moved them.
  it('hands each plan where the environment moves the logins', async () => {
    const configDirs = { GH_CONFIG_DIR: '/srv/gh' };
    const { plans } = setup(undefined, {}, undefined, undefined, { sandbox: true, configDirs });
    assert.deepEqual((await plans.plan(start)).permissions.configDirs, configDirs);
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

  describe("a plan brewer's repositories (ADR 0233)", () => {
    const repositories = [
      { repo: 'acme/api', base: 'origin/main' },
      { repo: 'acme/web', base: 'origin/trunk' },
    ];
    const resolve = ['rev-parse', '--verify', '--end-of-options', 'origin/trunk^{commit}'];
    /** Plans with a plan brewer whose frontmatter has `more`, a git and a fetch that record each call. */
    const planning = (
      answer: (call: number) => { code: number; stdout: string; stderr: string },
      fetch: () => Promise<void> = async () => {},
      more: Record<string, unknown> = {},
    ) => {
      const loaded = loadRecipes({
        recipes: [
          {
            path: 'recipes/pale.jsonc',
            // A brewer that commits needs a step that opens a pull request with them (ADR 0084).
            text: recipeText(
              'pale',
              [
                { id: 'brew', brewer: 'brewmaster' },
                ...(more.produces === 'commits' ? [{ action: 'openPullRequest' }] : []),
              ],
              { testFirst: false },
            ),
          },
        ],
        brewers: [
          {
            path: 'brewers/brewmaster.md',
            text: brewerText('brewmaster', {
              output: { doc: 'plan.md', schema: 'plan' },
              tools: { allow: ['Read'] },
              ...more,
            }),
          },
        ],
      });
      assert.ok(loaded.valid, loaded.valid ? '' : loaded.problems.join('\n'));
      const calls: string[] = [];
      const { plans } = setup([...ordered, started], {}, '', loaded.brewers, {
        repositories,
        git: async (cwd, args) => {
          calls.push(`${cwd} ${args.join(' ')}`);
          return answer(calls.length);
        },
        fetchBase: async (repo) => {
          calls.push(`fetch ${repo}`);
          await fetch();
        },
      });
      return { plans, calls };
    };
    const web = join('/clones', 'acme/web');
    const own = { repo: 'acme/api', clone: join('/clones', 'acme/api'), commit: 'c'.repeat(40) };
    const at = { code: 0, stdout: `${'d'.repeat(40)}\n`, stderr: '' };
    const none = { code: 128, stdout: '', stderr: 'fatal: Needed a single revision' };

    it('gives each repository of the Brewery and the commit its paths are checked at', async () => {
      const { plans, calls } = planning(() => at);
      assert.deepEqual((await plans.plan(start)).touches, [
        own,
        { repo: 'acme/web', clone: web, commit: 'd'.repeat(40) },
      ]);
      // Its own repository at its worktree's commit; another at its base, with no fetch.
      assert.deepEqual(calls, [`${web} ${resolve.join(' ')}`]);
      // Any other brewer's attempt has none.
      assert.equal((await setup().plans.plan(start)).touches, undefined);
    });

    it('fetches a base the clone has no ref of once, through its worktree manager, then reads it', async () => {
      const { plans, calls } = planning((call) => (call === 1 ? none : at));
      assert.deepEqual((await plans.plan(start)).touches, [
        own,
        { repo: 'acme/web', clone: web, commit: 'd'.repeat(40) },
      ]);
      assert.deepEqual(calls, [
        `${web} ${resolve.join(' ')}`,
        'fetch acme/web',
        `${web} ${resolve.join(' ')}`,
      ]);
    });

    it('still plans the attempt when that fetch fails, with why for the check to report', async () => {
      const { plans } = planning(
        () => none,
        async () => {
          throw new Error('git fetch failed: could not read from remote');
        },
      );
      const [, other] = (await plans.plan(start)).touches ?? [];
      assert.deepEqual(other, {
        repo: 'acme/web',
        clone: web,
        unread:
          'its base origin/trunk could not be fetched: git fetch failed: could not read from remote',
      });
    });

    it("reads the base no more after a fetch that fails, and carries git's reason when the base is still missing after one that succeeds (regression test)", async () => {
      const failing = planning(
        () => none,
        async () => {
          throw new Error('offline');
        },
      );
      await failing.plans.plan(start);
      assert.deepEqual(failing.calls, [`${web} ${resolve.join(' ')}`, 'fetch acme/web']);
      const missing = planning(() => none);
      const [, other] = (await missing.plans.plan(start)).touches ?? [];
      assert.deepEqual(other, {
        repo: 'acme/web',
        clone: web,
        unread: `the base origin/trunk of acme/web was not read: git ${resolve.join(' ')} exited with code 128: fatal: Needed a single revision`,
      });
      assert.deepEqual(missing.calls, [
        `${web} ${resolve.join(' ')}`,
        'fetch acme/web',
        `${web} ${resolve.join(' ')}`,
      ]);
    });

    it('keeps where the commits of a plan brewer that commits are counted', async () => {
      const { plans } = planning(() => at, undefined, {
        produces: 'commits',
        access: 'write',
        git: { commit: true },
        tools: { allow: ['Read', 'Write'] },
      });
      const planned = await plans.plan(start);
      assert.deepEqual(planned.commits, {
        clone: join('/clones', 'acme/api'),
        branch: 'foedrum/12-1/brew/1',
      });
      assert.equal(planned.touches?.length, 2);
    });
  });
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

  it('lets a Gauger its red proof sent back name its tests without a commit, in the retries of that round too (ADR 0258)', () => {
    const found = loaded.brewers.find('pale', 'brew');
    assert.ok(found !== undefined);
    const gauger = {
      ...found,
      brewer: {
        ...found.brewer,
        produces: 'commits' as const,
        git: { commit: true },
        output: { doc: 'gauge.md', schema: 'gauge' },
      },
    };
    const brewers = {
      find: (recipe: string, stepId: string) =>
        stepId === 'brew' ? gauger : loaded.brewers.find(recipe, stepId),
    };
    // Step red proves step brew; step lint is an ordinary check.
    const checks = {
      proves: (recipe: string, stepId: string) =>
        recipe === 'pale' && stepId === 'red' ? 'brew' : undefined,
    };
    const second = { ...ref, attempt: 2 };
    const third = { ...ref, attempt: 3 };
    const secondSession = '1f8fad5b-d9cb-469f-a165-70867728950e';
    const secondWorktree = join('/work', 'brew-2');
    const routedBy = (from: string, why: 'failed' | 'findings' = 'failed'): Event[] => [
      ...ordered,
      started,
      {
        type: 'step.finished',
        ...ref,
        outcome: {
          kind: 'succeeded',
          output: { status: 'done', summary: 'Gauged', assumptions: [] },
        },
      },
      {
        type: 'step.scheduled',
        ...second,
        deadlineAt: '2026-10-17T13:00:00.000Z',
        route: { from, why },
      },
      {
        type: 'step.started',
        ...second,
        session: { id: secondSession, worktree: secondWorktree },
        worktree: {
          repo: 'acme/api',
          path: secondWorktree,
          branch: 'foedrum/12-1/brew/2',
          commit: 'd'.repeat(40),
        },
      },
      {
        type: 'step.finished',
        ...second,
        outcome: {
          kind: 'failed',
          retryable: false,
          reason: 'the out doc says done, but the brewer made no commit since ddddddd: Gauged',
        },
        claude: { version: '2.1.301', model: 'claude-sonnet-5-5' },
      },
      { type: 'step.scheduled', ...third, deadlineAt: '2026-10-17T14:00:00.000Z', retry: true },
      {
        type: 'step.started',
        ...third,
        session: { id: secondSession, resumes: secondSession, worktree: secondWorktree },
      },
    ];
    const limitsOf = (events: Event[], attempt: typeof ref) =>
      setup(events, {}, undefined, brewers, { checks }).plans.limits(attempt);
    const red = routedBy('red');
    assert.equal(limitsOf(red, ref).namesOnly, undefined);
    assert.equal(limitsOf(red, second).namesOnly, true);
    // A retry starts as the attempt it retries, in the round that attempt is in (ADR 0117).
    assert.deepEqual(limitsOf(red, third), {
      outDoc: { file: 'gauge.md', schema: GaugeOutDoc },
      maxTurns: 30,
      commitsSince: 'd'.repeat(40),
      namesOnly: true,
    });
    // A check that proves nothing red, and a recipe without red proofs, send no Gauger back so.
    assert.equal(limitsOf(routedBy('lint'), second).namesOnly, undefined);
    const plain = setup(red, {}, undefined, brewers).plans;
    assert.equal(plain.limits(second).namesOnly, undefined); // Each condition alone: findings from the red step, and a red proof of another step.
    assert.equal(limitsOf(routedBy('red', 'findings'), second).namesOnly, undefined);
    const other = {
      proves: (recipe: string, stepId: string) => (stepId === 'red' ? 'review' : undefined),
    };
    const elsewhere = setup(red, {}, undefined, brewers, { checks: other }).plans;
    assert.equal(elsewhere.limits(second).namesOnly, undefined);
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
