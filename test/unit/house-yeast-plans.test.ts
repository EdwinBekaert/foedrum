// House-yeast rules reach a batch's brewers (#434, ADR 0169): the attempt plans select a Brewery's
// and a repository's rules by the files the batch changed and the step's lens, give each as an
// untrusted input, and record the selection with the attempt. git and the files are fakes.

import assert from 'node:assert/strict';
import { devNull } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { type AttemptPlansOptions, createAttemptPlans } from '../../src/brewers/attempt-plans.ts';
import { baseMergeKey } from '../../src/engine/base-merge.ts';
import { FOEDRUM_DEFAULTS, readBreweryFiles } from '../../src/engine/brewery-files.ts';
import { effectKey } from '../../src/engine/effect-key.ts';
import { fold } from '../../src/engine/fold.ts';
import { loadRecipes, MAX_INPUT_BYTES } from '../../src/engine/recipe-files.ts';
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
const scheduled = (stepId: string, attempt = 1): Event => ({
  type: 'step.scheduled',
  batchId: '12-1',
  stepId,
  attempt,
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
/** The events up to `next`'s attempt, after `done`'s commits from `base` to `head`. */
const after = (done: string, next: string): Event[] => [
  ...ordered,
  scheduled(done),
  startedAt(done, base),
  {
    type: 'step.finished',
    batchId: '12-1',
    stepId: done,
    attempt: 1,
    outcome: { kind: 'succeeded', output: { status: 'done', summary: 'Done', assumptions: [] } },
  },
  scheduled(next),
  startedAt(next, head),
];
/** The Taster's attempt, after Cellarman's commits. */
const tasting = after('implement', 'correctness');

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
    // As the runner does, git is stopped once its output passes the limit, which keeps its start
    // (ADR 0035).
    const ok = (stdout: string) => {
      const limit = options?.maxOutputBytes;
      if (limit === undefined || Buffer.byteLength(stdout) <= limit) {
        return { code: 0, stdout, stderr: '' };
      }
      const start = Buffer.from(stdout).subarray(0, limit).toString();
      return { code: null, stdout: start, stderr: '', killed: 'too-much-output' as const };
    };
    if (args.includes('--name-status')) {
      const lines = changed.split('\n').filter((line) => line !== '');
      // Without -z, git quotes a path with a double quote, backslash, tab or line feed in it, even
      // with core.quotePath=false.
      const quoted = (path: string) =>
        /["\\\t\n]/.test(path) ? `"${path.replace(/["\\]/g, '\\$&').replace(/\t/g, '\\t')}"` : path;
      return ok(
        args.includes('-z')
          ? lines.map((line) => `${line.split('\t').join('\0')}\0`).join('')
          : lines.map((line) => `${line.split('\t').map(quoted).join('\t')}\n`).join(''),
      );
    }
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
  attempt = 1,
  brewers = loaded.valid ? loaded.brewers : assert.fail(),
) => {
  const calls: { cwd: string; args: readonly string[]; options?: GitOptions }[] = [];
  const plans = createAttemptPlans({
    state: () => fold(events),
    brewers,
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
  const ref = { batchId: '12-1', stepId, attempt };
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
            '-z',
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

  it('matches a changed file whose path git would quote', async () => {
    const { plan } = await planOf(repository('M\tsrc/say "hi".ts\n'));
    assert.deepEqual((await plan).houseYeast, { selected: ['waits'], cut: [] });
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

  it("takes the repository's rules when git prints exactly the input limit", async () => {
    // What git prints is the blob's header, its text and a line feed: 55 bytes besides the text.
    const bare = Buffer.byteLength(rule('edge', {}, ''));
    const edge = rule('edge', {}, 'x'.repeat(MAX_INPUT_BYTES - 55 - bare));
    const { plan } = await planOf(repository('M\tsrc/wait.ts\n', { edge }));
    // Past the budget of about 2,000 tokens, so it is cut.
    assert.deepEqual((await plan).houseYeast, { selected: [], cut: ['edge'] });
  });

  it('reads the rules and the changed files from the base the batch last merged (ADR 0164)', async () => {
    const merged = 'c'.repeat(40);
    const key = effectKey.encode(
      baseMergeKey({ batchId: '12-1', stepId: 'implement', attempt: 1 }),
    );
    const events: Event[] = [
      ...tasting.slice(0, -2),
      { type: 'effect.applied', key, result: { base: merged, merged: 'd'.repeat(40) } },
      ...tasting.slice(-2),
    ];
    const { plan, calls } = await planOf(repository('M\tsrc/wait.ts\n'), 'correctness', events);
    assert.deepEqual((await plan).houseYeast, { selected: ['waits'], cut: [] });
    const argsOf = (word: string) => calls.find(({ args }) => args.includes(word))?.args ?? [];
    assert.equal(argsOf('ls-tree')[2], merged);
    assert.deepEqual(argsOf('--name-status').slice(-2), [merged, head]);
  });

  it('gives a resumed attempt no rules again, and records none (ADR 0117)', async () => {
    const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
    const events: Event[] = [
      ...tasting,
      {
        type: 'step.finished',
        batchId: '12-1',
        stepId: 'correctness',
        attempt: 1,
        outcome: { kind: 'failed', retryable: true, reason: 'claude exited' },
      },
      scheduled('correctness', 2),
      {
        type: 'step.started',
        batchId: '12-1',
        stepId: 'correctness',
        attempt: 2,
        session: { id, resumes: id, worktree: join('/work', 'correctness') },
      },
    ];
    const { plan, calls } = await planOf(
      repository('M\tsrc/wait.ts\n'),
      'correctness',
      events,
      undefined,
      2,
    );
    const { prompt, houseYeast } = await plan;
    assert.ok(!prompt.includes('name="houseYeast"'));
    assert.equal(houseYeast, undefined);
    assert.ok(!calls.some(({ args }) => args[0] === 'ls-tree' || args.includes('--name-status')));
  });
});

describe('createAttemptPlans: house yeast of a step of several lenses together (#560, ADR 0220)', () => {
  it('gives the step the rules of each of its lenses, each once, in their order (regression test, review of #571)', async () => {
    const together = loadRecipes({
      ...readBreweryFiles(join(FOEDRUM_DEFAULTS, 'no-such-brewery')),
      recipes: [
        {
          path: 'recipes/amber.jsonc',
          text: recipeText(
            'amber',
            [
              { id: 'implement', brewer: 'cellarman' },
              {
                id: 'correctness',
                brewer: 'taster',
                lenses: ['diff/security', 'diff/correctness'],
              },
              { action: 'openPullRequest' },
            ],
            { testFirst: false },
          ),
        },
      ],
    });
    assert.ok(together.valid, together.valid ? '' : together.problems.join('\n'));
    const secrets = rule(
      'secrets',
      { globs: ['src/**'], lens: 'diff/security' },
      'No token in a log.',
    );
    const everywhere = rule('everywhere', { globs: ['src/**'] }, 'Name things plainly.');
    const git = repository('M\tsrc/wait.ts\n', { waits: WAITS, secrets, everywhere });
    const { plan } = planOf(git, 'correctness', tasting, undefined, 1, together.brewers);
    const { prompt, houseYeast } = await plan;
    assert.deepEqual(houseYeast, { selected: ['secrets', 'everywhere', 'waits'], cut: [] });
    const at = (id: string) => prompt.indexOf(ruleInput(id, `.foedrum/house-yeast/${id}.md`));
    assert.ok(
      at('secrets') > 0 && at('everywhere') > at('secrets') && at('waits') > at('everywhere'),
    );
    assert.equal(prompt.split('name="houseYeast"').length, 4, 'a rule not once');
  });
});

describe('createAttemptPlans: house yeast of the brewers that write the change (#671)', () => {
  // The default Gauger and Cellarman, with a Taster through one lens.
  const writers = loadRecipes({
    ...readBreweryFiles(join(FOEDRUM_DEFAULTS, 'no-such-brewery')),
    recipes: [
      {
        path: 'recipes/amber.jsonc',
        text: recipeText(
          'amber',
          [
            { id: 'gauge', brewer: 'gauger' },
            { id: 'implement', brewer: 'cellarman' },
            { id: 'correctness', brewer: 'taster', lens: 'diff/correctness' },
            { action: 'openPullRequest' },
          ],
          { testFirst: false },
        ),
      },
    ],
  });
  assert.ok(writers.valid, writers.valid ? '' : writers.problems.join('\n'));
  const brewers = writers.valid ? writers.brewers : assert.fail();
  /** The Cellarman's attempt, after the Gauger's commits. */
  const implementing = after('gauge', 'implement');
  const implement = (git: Git) =>
    planOf(git, 'implement', implementing, undefined, 1, brewers).plan;
  const NEAR_MISS = rule(
    'near-miss',
    { globs: ['test/**/*.ts'], lens: 'diff/test-design' },
    'Every rule of a text form has a near miss.',
  );

  it('loads the default Gauger and Cellarman asking for house yeast, with their prompts referring to it', () => {
    for (const step of ['gauge', 'implement']) {
      const found = brewers.find('amber', step);
      assert.equal(found?.brewer.houseYeast, true, step);
      assert.ok(found?.instructions.includes('{houseYeast}'), step);
    }
  });

  it('gives a Cellarman attempt the rule whose globs match a file the Gauger committed', async () => {
    const keys = rule('keys', { globs: ['src/schemas/**'] }, 'A key part has a second value.');
    const git = repository('A\ttest/unit/limit.test.ts\nM\tsrc/schemas/events.ts\n', {
      keys,
      'docs-tone': DOCS,
    });
    const { prompt, houseYeast } = await implement(git);
    assert.deepEqual(houseYeast, { selected: ['keys'], cut: [] });
    assert.ok(prompt.includes(`${ruleInput('keys', '.foedrum/house-yeast/keys.md')}A key part`));
  });

  it('gives a writer the rule of a lens no step of its recipe runs', async () => {
    const git = repository('A\ttest/unit/limit.test.ts\n', { 'near-miss': NEAR_MISS });
    assert.deepEqual((await implement(git)).houseYeast, { selected: ['near-miss'], cut: [] });
  });

  it('gives a writer the rules of every lens within one budget, not one per lens', async () => {
    const long = (id: string, lens: string) =>
      rule(id, { globs: ['src/**'], lens }, 'x'.repeat(4800));
    const git = repository('M\tsrc/wait.ts\n', {
      'a-first': long('a-first', 'diff/security'),
      'b-second': long('b-second', 'diff/test-design'),
    });
    assert.deepEqual((await implement(git)).houseYeast, {
      selected: ['a-first'],
      cut: ['b-second'],
    });
  });

  it('gives a Taster no rule of a lens its step does not run (regression test, #671)', async () => {
    const git = repository('A\ttest/unit/limit.test.ts\n', { 'near-miss': NEAR_MISS });
    const { plan } = planOf(git, 'correctness', tasting, undefined, 1, brewers);
    assert.deepEqual((await plan).houseYeast, { selected: [], cut: [] });
  });
});
