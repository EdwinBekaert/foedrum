// The checks before a brewer's end in an attempt's plan (ADR 0381): the default Cellarman and Finer
// ask for them, the plan holds the repository's checks, the red step's test files through the
// test map, the attempt's deadline and the checks' environment, and no other brewer's plan holds
// them (ADR 0021: a fake git and test map, the defaults as they ship).

import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { describe, it } from 'node:test';
import { createAttemptPlans } from '../../src/brewers/attempt-plans.ts';
import { sendBackChecks } from '../../src/brewers/send-back.ts';
import type { RepositoryChecks } from '../../src/checks/gravity.ts';
import type { MapRead, ReadTestMapAt } from '../../src/checks/test-map.ts';
import type { AttemptRef } from '../../src/engine/attempt-key.ts';
import { FOEDRUM_DEFAULTS, readBreweryFiles } from '../../src/engine/brewery-files.ts';
import { fold } from '../../src/engine/fold.ts';
import { loadRecipes } from '../../src/engine/recipe-files.ts';
import type { Event } from '../../src/schemas/events.ts';
import { OutDocFrontmatter } from '../../src/schemas/out-doc.ts';
import type { Git, GitResult } from '../../src/workspace/git.ts';

const noFiles = readBreweryFiles(join(FOEDRUM_DEFAULTS, 'no-such-brewery'));
const loaded = loadRecipes(noFiles);
assert.ok(loaded.valid, loaded.valid ? '' : loaded.problems.join('\n'));

const root = join('/work', 'acme.api', 'attempts', '12-1');
// Each step's attempt has a deadline of its own, and the batch's routing another.
const deadlines: Record<string, string> = {
  gauge: '2026-10-18T12:10:00.000Z',
  implement: '2026-10-18T12:30:00.000Z',
  fine: '2026-10-18T12:50:00.000Z',
};
const deadlineAt = (stepId: string): string => deadlines[stepId] ?? '2026-10-18T13:00:00.000Z';
const gaugeStart = 'a'.repeat(40);
const worktree = (stepId: string, commit: string) => ({
  repo: 'acme/api',
  path: join(root, stepId, '1'),
  branch: `foedrum/12-1/${stepId}/1`,
  commit,
});
const sessions: Record<string, string> = {
  gauge: '0f8fad5b-d9cb-469f-a165-70867728950a',
  implement: '0f8fad5b-d9cb-469f-a165-70867728950b',
  fine: '0f8fad5b-d9cb-469f-a165-70867728950c',
  map: '0f8fad5b-d9cb-469f-a165-70867728950d',
};
const at = (stepId: string): AttemptRef => ({ batchId: '12-1', stepId, attempt: 1 });
const started = (stepId: string, commit: string): Event[] => [
  { type: 'step.scheduled', ...at(stepId), deadlineAt: deadlineAt(stepId) },
  {
    type: 'step.started',
    ...at(stepId),
    session: { id: sessions[stepId] ?? '', worktree: worktree(stepId, commit).path },
    worktree: worktree(stepId, commit),
  },
];
const ordered: Event[] = [
  {
    type: 'batch.ordered',
    batchId: '12-1',
    order: { issue: 12 },
    routeBy: '2026-10-18T14:00:00.000Z',
  },
  { type: 'batch.recipe_chosen', batchId: '12-1', recipe: 'nip', reason: 'l', source: 'label' },
  // The Maltster's map, which the Gauger, Cellarman and the Finer read (ADR 0395).
  ...started('map', gaugeStart),
  {
    type: 'step.finished',
    ...at('map'),
    outcome: { kind: 'succeeded', output: { status: 'done', summary: 'Mapped', assumptions: [] } },
  },
];
const gauged: Event[] = [
  ...started('gauge', gaugeStart),
  {
    type: 'step.finished',
    ...at('gauge'),
    outcome: { kind: 'succeeded', output: { status: 'done', summary: 'Red', tests: ['adds'] } },
  },
];

// The Gauger's commits: a test file in the map's test area, and a fixture outside it.
const gaugeDiff = [
  'diff --git a/test/add.test.mjs b/test/add.test.mjs',
  '--- /dev/null',
  '+++ b/test/add.test.mjs',
  '@@ -0,0 +1 @@',
  "+test('adds two numbers', () => assert.equal(add(1, 2), 3));",
  'diff --git a/fixtures/numbers.json b/fixtures/numbers.json',
  '--- /dev/null',
  '+++ b/fixtures/numbers.json',
  '@@ -0,0 +1 @@',
  '+[1, 2]',
  '',
].join('\n');
const ok = (stdout: string): GitResult => ({ code: 0, stdout, stderr: '' });
// The Finer's change is read with git log and diff too: the log names no commit.
const git: Git = async (_cwd, args) => ok(args.includes('diff') ? gaugeDiff : '');
const map: MapRead = {
  kind: 'map',
  map: {
    derivedFrom: { globs: ['package.json'], paths: ['package.json'] },
    modules: [
      {
        name: 'api',
        code: ['src/**'],
        tests: { paths: ['test/**'] },
        testReport: { format: 'tap', path: 'report.tap' },
        coverage: 'none',
      },
    ],
  },
};
const checks: RepositoryChecks = {
  build: null,
  typecheck: 'tsc',
  lint: { run: 'biome lint', files: true },
  format: { run: 'biome format', files: true },
  test: { run: 'node --test', files: true },
};

const plansOf = (
  events: Event[],
  readers: { git?: Git; testMapAt?: ReadTestMapAt; repoChecks?: RepositoryChecks | null } = {},
) =>
  createAttemptPlans({
    state: () => fold(events),
    brewers: loaded.brewers,
    models: { models: { builder: 'claude-sonnet-5-5', reader: 'claude-haiku-5-5' }, brewers: {} },
    repoTools: () => ['Bash(npm test)'],
    // null: foedrum.jsonc gives the repository no checks.
    repoChecks: (repo) =>
      repo !== 'acme/api' || readers.repoChecks === null
        ? undefined
        : (readers.repoChecks ?? checks),
    provenStep: (recipe) => loaded.checks.redProof(recipe)?.of,
    clone: (repo) => join('/clones', repo),
    git: readers.git ?? git,
    testMapAt: readers.testMapAt ?? (async () => map),
    sandbox: false,
    workRoot: join('/root'),
    env: {
      base: { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk-test', CLAUDE_CONFIG_DIR: '/c' },
      forced: { npm_config_ignore_scripts: 'true' },
    },
    platform: 'linux',
    orderText: async () => 'Add a --json flag.',
    orderComments: async () => [],
    files: { read: () => ({ kind: 'text', text: '# Guide' }), makeFolder: () => {} },
  });
const startOf = (stepId: string) => ({
  ref: at(stepId),
  limits: { outDoc: { file: 'out.md', schema: OutDocFrontmatter } },
});

describe('createAttemptPlans: the checks before the end (ADR 0381)', () => {
  it("the Cellarman's and the Finer's attempt plans hold the send-back checks", async () => {
    const implementing = [...ordered, ...gauged, ...started('implement', 'c'.repeat(40))];
    const fining = [...implementing, ...started('fine', 'd'.repeat(40))];
    for (const [stepId, events] of [
      ['implement', implementing],
      ['fine', fining],
    ] as const) {
      const plan = await plansOf(events).plan(startOf(stepId));
      assert.deepEqual(plan.sendBack?.checks, sendBackChecks(checks, 'linux'), stepId);
      // The red step's test file, never its fixture outside the map's test area.
      assert.deepEqual(plan.sendBack?.redTests, ['test/add.test.mjs'], stepId);
      assert.equal(plan.sendBack?.deadlineAt, deadlineAt(stepId), stepId);
      assert.equal(plan.sendBack?.unsandboxed, false, stepId);
      // claude's login is claude's alone, as for a check (ADR 0069).
      assert.equal(plan.sendBack?.env.ANTHROPIC_API_KEY, undefined, stepId);
      assert.equal(plan.sendBack?.env.npm_config_ignore_scripts, 'true', stepId);
    }
  });

  it("reads the red step's test files in its own commits, by the map at its tip", async () => {
    const gaugeTip = 'refs/heads/foedrum/12-1/gauge/1';
    const otherDiff = [
      'diff --git a/test/other.test.mjs b/test/other.test.mjs',
      '--- /dev/null',
      '+++ b/test/other.test.mjs',
      '@@ -0,0 +1 @@',
      '+x',
      '',
    ].join('\n');
    // Only the Gauger's range has its test; any other diff names another file.
    const byRange: Git = async (_cwd, args) => {
      if (!args.includes('diff')) return ok('');
      return ok(args.includes(gaugeStart) && args.includes(gaugeTip) ? gaugeDiff : otherDiff);
    };
    const asked: string[] = [];
    const byCommit: ReadTestMapAt = async (_repo, commit) => {
      asked.push(commit);
      return commit === gaugeTip ? map : { kind: 'none' };
    };
    const events = [...ordered, ...gauged, ...started('implement', 'c'.repeat(40))];
    const plan = await plansOf(events, { git: byRange, testMapAt: byCommit }).plan(
      startOf('implement'),
    );
    assert.deepEqual(plan.sendBack?.redTests, ['test/add.test.mjs']);
    assert.ok(asked.includes(gaugeTip), asked.join(', '));
  });

  it("holds no red tests, its checks still, when git cannot read the red step's commits or its map cannot be read", async () => {
    const events = [...ordered, ...gauged, ...started('implement', 'c'.repeat(40))];
    const failing: Git = async (_cwd, args) =>
      args.includes('diff') ? { code: 128, stdout: '', stderr: 'fatal: bad object' } : ok('');
    const unreadable: ReadTestMapAt = async () => ({ kind: 'unreadable', reason: 'not JSONC' });
    for (const readers of [{ git: failing }, { testMapAt: unreadable }]) {
      const plan = await plansOf(events, readers).plan(startOf('implement'));
      assert.deepEqual(plan.sendBack?.checks, sendBackChecks(checks, 'linux'));
      assert.deepEqual(plan.sendBack?.redTests, []);
    }
  });

  it('holds no red tests when the batch has no red step', async () => {
    // Nip without test-first skips its survey, its Gauger and its red proof.
    const skipped: Event[] = ['survey', 'survey-check', 'gauge', 'red'].map((stepId) => ({
      type: 'step.skipped',
      batchId: '12-1',
      stepId,
      when: 'recipe.testFirst',
    }));
    const events = [...ordered, ...skipped, ...started('implement', 'c'.repeat(40))];
    const plan = await plansOf(events).plan(startOf('implement'));
    assert.deepEqual(plan.sendBack?.checks, sendBackChecks(checks, 'linux'));
    assert.deepEqual(plan.sendBack?.redTests, []);
  });

  it("no other brewer's attempt plans hold the send-back checks", async () => {
    const plan = await plansOf([...ordered, ...started('gauge', gaugeStart)]).plan(
      startOf('gauge'),
    );
    assert.equal(plan.sendBack, undefined);
    // Every brewer of every default recipe: only the Cellarman and the Finer ask for them.
    const asking = new Set<string>();
    const every = new Set<string>();
    const recipes = readdirSync(join(FOEDRUM_DEFAULTS, 'recipes')).filter((file) =>
      file.endsWith('.jsonc'),
    );
    for (const file of recipes) {
      const name = basename(file, '.jsonc');
      for (const id of loaded.recipes.find(name)?.steps ?? []) {
        const found = loaded.brewers.find(name, id);
        if (found !== undefined) every.add(found.brewer.name);
        if (found?.brewer.checksBeforeEnd === true) asking.add(found.brewer.name);
      }
    }
    // The walk reached the other brewers too, so finding none of them asking means something.
    for (const brewer of [
      'gauger',
      'taster',
      'brewmaster',
      'innkeeper',
      'maltster-survey',
      'brett',
    ]) {
      assert.ok(every.has(brewer), brewer);
    }
    assert.deepEqual([...asking].sort(), ['cellarman', 'finer']);
  });
  it('holds no checks for a repository foedrum.jsonc gives none', async () => {
    const events = [...ordered, ...gauged, ...started('implement', 'c'.repeat(40))];
    const plan = await plansOf(events, { repoChecks: null }).plan(startOf('implement'));
    assert.equal(plan.sendBack, undefined);
    // The same plan with checks holds them, so their absence above is the repository's.
    assert.ok((await plansOf(events).plan(startOf('implement'))).sendBack !== undefined);
  });
});
