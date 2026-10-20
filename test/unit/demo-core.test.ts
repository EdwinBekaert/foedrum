import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import {
  BREWERY,
  breweryFiles,
  CRASH_LINE,
  type DemoRun,
  DIAGNOSIS,
  localConfig,
  ON_TAP_LINE,
  ORDER,
  problemsOf,
  scratchFolder,
  TARGET,
} from '../../scripts/demo/core.ts';
import { serveSetup } from '../../src/cli/serve-config.ts';
import type { BreweryFile } from '../../src/engine/recipe-files.ts';

const root = resolve('/repo/.claude/worktrees/193-demo');
const tmp = join(root, '.foedrum', 'tmp');

describe('scratchFolder', () => {
  it('is .foedrum/tmp/demo in the checkout when none is asked for', () => {
    assert.equal(scratchFolder(root, undefined, resolve('/elsewhere')), join(tmp, 'demo'));
  });

  it('takes a folder inside the checkout .foedrum/tmp, resolved against the working directory', () => {
    assert.equal(
      scratchFolder(root, join('tmp', 'tests', 'd'), join(root, '.foedrum')),
      join(tmp, 'tests', 'd'),
    );
    assert.equal(scratchFolder(root, join(tmp, 'x'), resolve('/elsewhere')), join(tmp, 'x'));
  });

  it('refuses a folder outside .foedrum/tmp, or .foedrum/tmp itself', () => {
    for (const asked of [
      tmp,
      root,
      join(root, '.foedrum'),
      join(tmp, '..', 'demo'),
      resolve('/elsewhere', 'demo'),
      join(root, '.foedrum', 'tmpx'),
    ]) {
      assert.throws(() => scratchFolder(root, asked, root), /\.foedrum[\\/]tmp/, asked);
    }
  });
});

describe('the demo Brewery', () => {
  const work = resolve('/scratch/work');
  const clone = resolve('/scratch/web');
  /** The Brewery's files, and what serve makes of them. */
  const demo = () => {
    const files = breweryFiles();
    const of = (folder: string): BreweryFile[] =>
      Object.entries(files)
        .filter(([path]) => path.startsWith(`${folder}/`))
        .map(([path, text]) => ({ path, text }));
    const ready = serveSetup({
      root: resolve('/scratch/brewery'),
      home: resolve('/scratch/home'),
      platform: process.platform,
      env: {},
      files: {
        config: files['foedrum.jsonc'],
        local: localConfig(work, clone),
        models: files['models.jsonc'],
        brewery: { recipes: of('recipes'), brewers: of('brewers') },
      },
      diagnosis: DIAGNOSIS,
    });
    return { files, ready };
  };

  it('is one serve accepts, with the work root and the clone it is given', () => {
    const { ready } = demo();
    assert.equal(ready.kind, 'ready', JSON.stringify(ready));
    if (ready.kind !== 'ready') return;
    const { setup } = ready;
    assert.equal(setup.brewery, BREWERY);
    assert.equal(setup.workRoot, work);
    assert.deepStrictEqual(
      setup.repositories.map(({ repo, source, clone: at }) => ({ repo, source, clone: at })),
      [{ repo: TARGET, source: 'local', clone }],
    );
    assert.equal(setup.sandbox, false);
  });

  it('routes the order to a recipe whose brewer gets a second attempt after the crash, then opens the pull request', () => {
    const { files, ready } = demo();
    assert.equal(ready.kind, 'ready');
    if (ready.kind !== 'ready') return;
    const name = ORDER.labels[0]?.replace(/^recipe:/, '') ?? '';
    const recipe = ready.setup.recipes.find(name);
    assert.ok(recipe !== undefined, name);
    assert.ok(files[`recipes/${name}.jsonc`]?.includes('openPullRequest'));
    const brewer = ready.setup.brewers.find(name, 'brew')?.brewer;
    assert.ok((brewer?.maxAttempts ?? 1) >= 2, JSON.stringify(brewer));
    assert.equal(brewer?.produces, 'commits');
  });

  it('ignores its own .foedrum folder', () => {
    assert.match(demo().files['.gitignore'] ?? '', /^\.foedrum\/$/m);
  });
});

describe('problemsOf', () => {
  const pull = { title: ORDER.title, head: 'foedrum/demo.brewery/1-1/demo.web', base: 'main' };
  const run = (fields: Partial<DemoRun> = {}): DemoRun => ({
    crash: { exitCode: 1, output: `started\n${CRASH_LINE}\n` },
    restart: { exitCode: 0, output: `${ON_TAP_LINE}: https://example.test/pull/1\n` },
    pulls: [pull],
    comments: [{ author: 'cellar-bot', body: 'On tap' }],
    ...fields,
  });

  it('finds nothing in a run that crashed, came back and went on tap with one pull request and one comment', () => {
    assert.deepStrictEqual(problemsOf(run()), []);
  });

  it('says when the first life did not crash mid-attempt', () => {
    assert.match(
      problemsOf(run({ crash: { exitCode: 0, output: 'stopped\n' } })).join('\n'),
      /not killed mid-attempt/,
    );
    assert.match(
      problemsOf(run({ crash: { exitCode: 1, output: 'boom\n' } })).join('\n'),
      /not killed mid-attempt.*boom/s,
    );
  });

  it('says when the restart did not end with the batch on tap', () => {
    const problems = problemsOf(run({ restart: { exitCode: 1, output: 'the lock is held\n' } }));
    assert.match(problems.join('\n'), /not on tap.*the lock is held/s);
    const timedOut = { exitCode: null, output: '', killed: 'timed-out' as const };
    assert.match(problemsOf(run({ restart: timedOut })).join('\n'), /not on tap/);
  });

  it('counts the pull requests and the comments', () => {
    assert.match(problemsOf(run({ pulls: [] })).join('\n'), /0 pull requests, not 1/);
    assert.match(problemsOf(run({ pulls: [pull, pull] })).join('\n'), /2 pull requests, not 1/);
    assert.match(problemsOf(run({ comments: [] })).join('\n'), /0 status comments, not 1/);
  });
});
