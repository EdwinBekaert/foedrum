// House-yeast rules reach a batch's brewers (#434, ADR 0169): the attempt plans select a Brewery's
// and a repository's rules by the files the batch changed and the step's lens, give each as an
// untrusted input, and record the selection with the attempt. git and the files are fakes.

import assert from 'node:assert/strict';
import { devNull } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { type AttemptPlansOptions, createAttemptPlans } from '../../src/brewers/attempt-plans.ts';
import { FOEDRUM_DEFAULTS, readBreweryFiles } from '../../src/engine/brewery-files.ts';
import { fold } from '../../src/engine/fold.ts';
import { loadRecipes } from '../../src/engine/recipe-files.ts';
import type { Event } from '../../src/schemas/events.ts';
import type { Git, GitOptions } from '../../src/workspace/git.ts';
import { brewerText, recipeText } from '../helpers/brewery-files.ts';

// No files of the Brewery's own but the recipe: the default Taster and Cellarman.
const loaded = loadRecipes({
  ...readBreweryFiles(join(FOEDRUM_DEFAULTS, 'no-such-brewery')),
  brewers: [{ path: 'brewers/scribe.md', text: brewerText('scribe') }],
  recipes: [
    {
      path: 'recipes/amber.jsonc',
      text: recipeText(
        'amber',
        [
          { id: 'implement', brewer: 'cellarman' },
          { id: 'note', brewer: 'scribe' },
          { id: 'correctness', brewer: 'taster', lens: 'diff/correctness' },
          { action: 'openPullRequest' },
        ],
        { testFirst: false },
      ),
    },
  ],
});
assert.ok(loaded.valid, loaded.valid ? '' : loaded.problems.join('\n'));

const base = 'a'.repeat(40);
const head = 'b'.repeat(40);
const worktree = (name: string, commit: string) => ({
  repo: 'acme/api',
  path: join('/work', name),
  branch: `foedrum/12-1/${name}`,
  commit,
});
const scheduled = (stepId: string): Event => ({
  type: 'step.scheduled',
  batchId: '12-1',
  stepId,
  attempt: 1,
  deadlineAt: '2026-10-24T13:00:00.000Z',
});
const startedAt = (stepId: string, commit: string): Event => ({
  type: 'step.started',
  batchId: '12-1',
  stepId,
  attempt: 1,
  session: { id: '0f8fad5b-d9cb-469f-a165-70867728950e', worktree: join('/work', stepId) },
  worktree: worktree(stepId, commit),
});
const ordered: Event[] = [
  {
    type: 'batch.ordered',
    batchId: '12-1',
    order: { issue: 12 },
    routeBy: '2026-10-24T13:00:00.000Z',
  },
  {
    type: 'batch.recipe_chosen',
    batchId: '12-1',
    recipe: 'amber',
    reason: 'label',
    source: 'label',
  },
];
/** The Taster's attempt, after Cellarman's commits. */
const tasting: Event[] = [
  ...ordered,
  scheduled('implement'),
  startedAt('implement', base),
  {
    type: 'step.finished',
    batchId: '12-1',
    stepId: 'implement',
    attempt: 1,
    outcome: { kind: 'succeeded', output: { status: 'done', summary: 'Done', assumptions: [] } },
  },
  scheduled('correctness'),
  startedAt('correctness', head),
];

const rule = (id: string, scope: object, body: string): string =>
  `---\n${JSON.stringify({ id, scope, kind: 'semantic', source: 'review of #7', created: '2026-10-01', status: 'active' })}\n---\n${body}\n`;
const WAITS = rule(
  'waits',
  { globs: ['src/**'], lens: 'diff/correctness' },
  'Every wait has a deadline.',
);
const DOCS = rule('docs-tone', { globs: ['docs/**'] }, 'One sentence per line.');

/** git in the clone: the changed files, the repository's rules at `base`, and the change. */
const repository = (changed: string, rules: Record<string, string> = { waits: WAITS }): Git => {
  const blobs = Object.keys(rules).map((id, i) => ({ id, blob: String(i + 1).repeat(40) }));
  return async (_cwd, args, options) => {
    const ok = (stdout: string) => ({ code: 0, stdout, stderr: '' });
    if (args.includes('--name-status')) return ok(changed);
    if (args[0] === 'ls-tree') {
      return ok(
        blobs
          .map(({ id, blob }) => `100644 blob ${blob}\t.foedrum/house-yeast/${id}.md\0`)
          .join(''),
      );
    }
    if (args[0] === 'cat-file') {
      const asked = (options?.stdin ?? '').split('\n').filter((line) => line !== '');
      return ok(
        asked
          .map((blob) => {
            const text = rules[blobs.find((b) => b.blob === blob)?.id ?? ''] ?? '';
            return `${blob} blob ${Buffer.byteLength(text)}\n${text}\n`;
          })
          .join(''),
      );
    }
    return ok(args[0] === 'log' ? 'f00dfee Wait\n' : 'diff --git a/src/wait.ts b/src/wait.ts\n');
  };
};

const planOf = (
  git: Git,
  stepId = 'correctness',
  events = tasting,
  houseYeast: AttemptPlansOptions['houseYeast'] = { files: [], keptIn: () => 'repo' },
) => {
  const calls: { cwd: string; args: readonly string[]; options?: GitOptions }[] = [];
  const plans = createAttemptPlans({
    state: () => fold(events),
    brewers: loaded.valid ? loaded.brewers : assert.fail(),
    models: { models: { builder: 'claude-sonnet-5-5' }, brewers: {} },
    repoTools: () => [],
    clone: (repo) => join('/clones', repo),
    sandbox: false,
    workRoot: join('/root'),
    env: { base: { PATH: '/usr/bin' }, forced: {} },
    platform: 'linux',
    orderText: async () => 'Wait for a bottle to be merged.',
    git: (cwd, args, options) => {
      calls.push({ cwd, args, ...(options === undefined ? {} : { options }) });
      return git(cwd, args, options);
    },
    ...(houseYeast === undefined ? {} : { houseYeast }),
    files: { read: () => ({ kind: 'text', text: 'out' }), makeFolder: () => {} },
    random: () => Buffer.from('0123456789abcdef0123456789abcdef', 'hex'),
  });
  const ref = { batchId: '12-1', stepId, attempt: 1 };
  return { plan: plans.plan({ ref, limits: plans.limits(ref) }), calls };
};

const ruleInput = (id: string, path: string) =>
  `source="house-yeast rule ${id}, file ${path}" name="houseYeast">\n## ${id} (semantic)\n\n`;

describe('createAttemptPlans: house yeast (#434, ADR 0169)', () => {
  it('gives the default Taster the repository rule that matches the changed files and its lens, as an input', async () => {
    const { plan, calls } = await planOf(repository('M\tsrc/wait.ts\nD\tdocs/old.md\n'));
    const { prompt, houseYeast } = await plan;
    assert.ok(
      prompt.includes(
        `${ruleInput('waits', '.foedrum/house-yeast/waits.md')}Every wait has a deadline.`,
      ),
      prompt.slice(prompt.indexOf('## Untrusted input')),
    );
    assert.match(prompt, /\{houseYeast\}/, 'the default Taster does not refer to its rules');
    assert.deepEqual(houseYeast, { selected: ['waits'], cut: [] });
    // In the clone, at the commit the batch started at: never the worktree, which the batch's own
    // commits could have changed (ADR 0169).
    const inClone = { 'core.hooksPath': devNull, 'core.fsmonitor': 'false' };
    const read = calls.filter(({ args }) => args[0] !== 'log' && !args.includes('--no-textconv'));
    assert.deepEqual(
      read.map(({ cwd, args, options }) => ({ cwd, args, config: options?.config })),
      [
        {
          cwd: join('/clones', 'acme/api'),
          args: [
            '-c',
            'core.quotePath=false',
            'diff',
            '--name-status',
            '--no-color',
            '--no-ext-diff',
            base,
            head,
          ],
          config: inClone,
        },
        {
          cwd: join('/clones', 'acme/api'),
          args: ['ls-tree', '-z', base, '--', '.foedrum/house-yeast/'],
          config: inClone,
        },
        { cwd: join('/clones', 'acme/api'), args: ['cat-file', '--batch'], config: inClone },
      ],
    );
    assert.equal(read[2]?.options?.stdin, `${'1'.repeat(40)}\n`);
  });

  it('leaves out a rule whose files the batch did not change, and records that it selected none', async () => {
    const { plan } = await planOf(repository('M\tsrc/wait.ts\n', { 'docs-tone': DOCS }));
    const { prompt, houseYeast } = await plan;
    assert.ok(!prompt.includes('name="houseYeast"'));
    assert.deepEqual(houseYeast, { selected: [], cut: [] });
  });

  it("reads a repository's rules from the Brewery when it keeps them there, and the Brewery layer, with no git read of rules", async () => {
    const files = [
      { path: 'house-yeast/acme/api/waits.md', text: WAITS },
      { path: 'house-yeast/everywhere.md', text: rule('everywhere', {}, 'Name things plainly.') },
    ];
    const { plan, calls } = await planOf(repository('M\tsrc/wait.ts\n'), 'correctness', tasting, {
      files,
      keptIn: (repo) => (repo === 'acme/api' ? 'brewery' : 'repo'),
    });
    const { prompt, houseYeast } = await plan;
    assert.ok(prompt.includes(ruleInput('waits', 'house-yeast/acme/api/waits.md')));
    assert.ok(prompt.includes(ruleInput('everywhere', 'house-yeast/everywhere.md')));
    assert.deepEqual(houseYeast, { selected: ['waits', 'everywhere'], cut: [] });
    assert.ok(!calls.some(({ args }) => args[0] === 'ls-tree' || args[0] === 'cat-file'));
  });

  it('gives no rules to a brewer that does not ask for them, and reads none', async () => {
    const events = [...ordered, scheduled('note'), startedAt('note', base)];
    const { plan, calls } = await planOf(repository('M\tsrc/wait.ts\n'), 'note', events);
    const { prompt, houseYeast } = await plan;
    assert.ok(!prompt.includes('name="houseYeast"'));
    assert.equal(houseYeast, undefined);
    assert.deepEqual(calls, []);
  });

  it("fails the plan, naming the git call, when the repository's rules cannot be read", async () => {
    const broken: Git = async (cwd, args, options) =>
      args[0] === 'ls-tree'
        ? { code: 128, stdout: '', stderr: 'fatal: not a tree object' }
        : repository('M\tsrc/wait.ts\n')(cwd, args, options);
    const { plan } = await planOf(broken);
    await assert.rejects(
      plan,
      /the house-yeast rules of acme\/api were not read: git ls-tree .* exited with code 128: fatal: not a tree object/,
    );
  });

  it("fails the plan when the repository's rules pass the input limit of 1 MiB", async () => {
    const huge = rule('huge', {}, 'x'.repeat(1024 * 1024));
    const { plan } = await planOf(repository('M\tsrc/wait.ts\n', { huge }));
    await assert.rejects(plan, /the house-yeast rules of acme\/api were not read: .*1048576 bytes/);
  });
});
