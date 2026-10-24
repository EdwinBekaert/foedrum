// House-yeast rules from a repository, read with real git (#434, ADR 0169): the attempt plans list
// .foedrum/house-yeast/ at the commit the batch started at, read the rules' blobs in one batch and
// match them against the files git says the batch changed. The commits are made with git's
// plumbing, so a path no file system on Windows takes (a double quote) can be in one: it is never
// checked out, so git need not protect NTFS from it.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createAttemptPlans } from '../../src/brewers/attempt-plans.ts';
import { FOEDRUM_DEFAULTS, readBreweryFiles } from '../../src/engine/brewery-files.ts';
import { fold } from '../../src/engine/fold.ts';
import { loadRecipes } from '../../src/engine/recipe-files.ts';
import { removeTree } from '../../src/platform/remove.ts';
import type { Event } from '../../src/schemas/events.ts';
import { runGit } from '../../src/workspace/git.ts';
import { recipeText } from '../helpers/brewery-files.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';

const git = (cwd: string, args: string[], input?: Buffer | string): string =>
  execFileSync(
    'git',
    [
      '-c',
      'core.protectNTFS=false',
      '-c',
      'user.name=Test',
      '-c',
      'user.email=t@example.com',
      ...args,
    ],
    {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(input === undefined ? {} : { input }),
    },
  ).trim();

const rule = (id: string, scope: object, body: string): string =>
  `---\n${JSON.stringify({ id, scope, kind: 'semantic', source: 'review of #7', created: '2026-10-01', status: 'active' })}\n---\n${body}\n`;

// The default Taster, in a recipe after a step that changes code.
const loaded = loadRecipes({
  ...readBreweryFiles(join(FOEDRUM_DEFAULTS, 'no-such-brewery')),
  recipes: [
    {
      path: 'recipes/amber.jsonc',
      text: recipeText(
        'amber',
        [
          { id: 'implement', brewer: 'cellarman' },
          { id: 'correctness', brewer: 'taster', lens: 'diff/correctness' },
          { action: 'openPullRequest' },
        ],
        { testFirst: false },
      ),
    },
  ],
});
assert.ok(loaded.valid, loaded.valid ? '' : loaded.problems.join('\n'));

describe('createAttemptPlans: a repository’s house-yeast rules with real git', () => {
  let dir: TempDir;
  let repo: string;
  let base: string;
  let head: string;
  before(() => {
    dir = makeTempDir('house-yeast-plans');
    repo = join(dir.path, 'clone');
    git(dir.path, ['init', '-q', '-b', 'main', repo]);
    const blob = (text: Buffer | string) => git(repo, ['hash-object', '-w', '--stdin'], text);
    const add = (mode: string, id: string, path: string) =>
      git(repo, ['update-index', '--add', '--cacheinfo', `${mode},${id},${path}`]);
    const commit = (message: string, parent?: string) =>
      git(repo, [
        'commit-tree',
        git(repo, ['write-tree']),
        ...(parent === undefined ? [] : ['-p', parent]),
        '-m',
        message,
      ]);
    const rules = '.foedrum/house-yeast';
    add(
      '100644',
      blob(rule('waits', { globs: ['src/**'] }, 'Every wait has a deadline.')),
      `${rules}/waits.md`,
    );
    // Saved in Windows-1252: its é is one byte that is not UTF-8. It sorts before waits.md, so
    // git prints it first.
    const accents = Buffer.concat([
      Buffer.from(rule('accents', {}, 'Caf').replace(/\n$/, '')),
      Buffer.from([0xe9, 0x0a]),
    ]);
    add('100644', blob(accents), `${rules}/accents.md`);
    add('120000', blob('waits.md'), `${rules}/link.md`);
    add('100644', blob(rule('deeper', {}, 'Not a rule here.')), `${rules}/folder.md/deeper.md`);
    add('100644', blob('Notes, not a rule.\n'), `${rules}/notes.txt`);
    add('100644', blob('export {};\n'), 'src/wait.ts');
    base = commit('Initial commit');
    add('100644', blob('export const hi = 1;\n'), 'src/say "hi".ts');
    head = commit('Say hi', base);
  });
  after(() => removeTree(dir.path));

  const worktree = (name: string, commit: string) => ({
    repo: 'acme/api',
    path: join(dir.path, 'work', name),
    branch: `foedrum/12-1/${name}`,
    commit,
  });
  const started = (stepId: string, commit: string): Event[] => [
    {
      type: 'step.scheduled',
      batchId: '12-1',
      stepId,
      attempt: 1,
      deadlineAt: '2026-10-24T13:00:00.000Z',
    },
    {
      type: 'step.started',
      batchId: '12-1',
      stepId,
      attempt: 1,
      session: {
        id: '0f8fad5b-d9cb-469f-a165-70867728950e',
        worktree: join(dir.path, 'work', stepId),
      },
      worktree: worktree(stepId, commit),
    },
  ];

  it('gives the Taster the rule for the files the batch changed, and leaves out what is not a rule', async () => {
    const events: Event[] = [
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
      ...started('implement', base),
      {
        type: 'step.finished',
        batchId: '12-1',
        stepId: 'implement',
        attempt: 1,
        outcome: {
          kind: 'succeeded',
          output: { status: 'done', summary: 'Done', assumptions: [] },
        },
      },
      ...started('correctness', head),
    ];
    const plans = createAttemptPlans({
      state: () => fold(events),
      brewers: loaded.valid ? loaded.brewers : assert.fail(),
      models: { models: { builder: 'claude-sonnet-5-5' }, brewers: {} },
      repoTools: () => [],
      clone: () => repo,
      sandbox: false,
      workRoot: join(dir.path, 'work'),
      env: { base: { PATH: process.env.PATH ?? '' }, forced: {} },
      orderText: async () => 'Say hi.',
      git: runGit,
      houseYeast: { files: [], keptIn: () => 'repo' },
      files: { read: () => ({ kind: 'text', text: 'out' }), makeFolder: () => {} },
      random: () => Buffer.from('0123456789abcdef0123456789abcdef', 'hex'),
    });
    const ref = { batchId: '12-1', stepId: 'correctness', attempt: 1 };
    const { prompt, houseYeast } = await plans.plan({ ref, limits: plans.limits(ref) });
    assert.deepEqual(houseYeast, {
      selected: ['waits'],
      cut: [],
      invalid: ['.foedrum/house-yeast/accents.md'],
    });
    assert.ok(
      prompt.includes(
        'source="house-yeast rule waits, file .foedrum/house-yeast/waits.md" name="houseYeast">\n## waits (semantic)\n\nEvery wait has a deadline.',
      ),
    );
  });
});
