// The merge-tree of an open pull request's head and its base's tip, with real git (ADR 0198): a
// clone with a pull request's head and a base that moved, merged in a git directory of Foedrum's
// own with the clone's objects, so a merge driver the clone's configuration names takes no part,
// and nothing is left in the git directories' root.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { runGit } from '../../src/workspace/git.ts';
import { openMergedTree, openMergeTree } from '../../src/workspace/merge-tree-git.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';

const git = (cwd: string, args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=t@example.com', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

describe('openMergeTree, with real git (ADR 0198)', () => {
  let dir: TempDir;
  let clone: string;
  let root: string;
  // The pull request's head, and three tips of main: one it merges with, one it conflicts with.
  let head: string;
  let cleanTip: string;
  let conflictTip: string;
  const machine = {
    global: process.env.GIT_CONFIG_GLOBAL,
    system: process.env.GIT_CONFIG_NOSYSTEM,
  };

  before(() => {
    dir = makeTempDir('merge-tree');
    const config = join(dir.path, 'gitconfig');
    writeFileSync(config, '[user]\n\tname = Test\n\temail = t@example.com\n');
    process.env.GIT_CONFIG_GLOBAL = config;
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    clone = join(dir.path, 'clone');
    root = join(dir.path, 'git-dirs');
    mkdirSync(clone);
    git(clone, ['init', '--quiet', '--initial-branch=main']);
    writeFileSync(join(clone, 'app.txt'), 'one\n');
    writeFileSync(join(clone, 'other.txt'), 'one\n');
    // Every file merges with the driver the clone's configuration names, which always resolves.
    writeFileSync(join(clone, '.gitattributes'), '* merge=always\n');
    git(clone, ['add', '.']);
    git(clone, ['commit', '--quiet', '-m', 'start']);
    git(clone, ['config', 'merge.always.driver', 'true']);
    git(clone, ['switch', '--quiet', '-c', 'bottle']);
    writeFileSync(join(clone, 'app.txt'), 'the batch\n');
    git(clone, ['commit', '--quiet', '-am', 'the batch']);
    head = git(clone, ['rev-parse', 'HEAD']);
    git(clone, ['switch', '--quiet', 'main']);
    writeFileSync(join(clone, 'other.txt'), 'main\n');
    git(clone, ['commit', '--quiet', '-am', 'main elsewhere']);
    cleanTip = git(clone, ['rev-parse', 'HEAD']);
    writeFileSync(join(clone, 'app.txt'), 'main too\n');
    git(clone, ['commit', '--quiet', '-am', 'main in the same place']);
    conflictTip = git(clone, ['rev-parse', 'HEAD']);
  });
  after(() => {
    for (const [name, value] of [
      ['GIT_CONFIG_GLOBAL', machine.global],
      ['GIT_CONFIG_NOSYSTEM', machine.system],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    dir.remove();
  });

  const mergeTree = () =>
    openMergeTree({ git: runGit, clone, own: { url: join(dir.path, 'nowhere.git'), root } });

  it('merges cleanly with a tip that changed other files', async () => {
    assert.deepStrictEqual(await mergeTree()(head, cleanTip), { kind: 'clean' });
  });

  it("names the conflicting file, whatever merge driver the clone's configuration names", async () => {
    assert.deepStrictEqual(await mergeTree()(head, conflictTip), {
      kind: 'conflicts',
      files: ['app.txt'],
    });
  });

  it('leaves no git directory behind, and moves no ref of the clone', async () => {
    const refs = git(clone, ['for-each-ref']);
    await mergeTree()(head, conflictTip);
    assert.equal(existsSync(root) ? readdirSync(root).length : 0, 0);
    assert.equal(git(clone, ['for-each-ref']), refs);
  });
});

describe('openMergedTree, with real git (ADR 0203)', () => {
  let dir: TempDir;
  let clone: string;
  let root: string;
  let head: string;
  let tip: string;
  const machine = {
    global: process.env.GIT_CONFIG_GLOBAL,
    system: process.env.GIT_CONFIG_NOSYSTEM,
  };

  before(() => {
    dir = makeTempDir('merged-tree');
    const config = join(dir.path, 'gitconfig');
    writeFileSync(config, '[user]\n\tname = Test\n\temail = t@example.com\n');
    process.env.GIT_CONFIG_GLOBAL = config;
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    clone = join(dir.path, 'clone');
    root = join(dir.path, 'git-dirs');
    mkdirSync(clone);
    git(clone, ['init', '--quiet', '--initial-branch=main']);
    writeFileSync(join(clone, 'app.txt'), 'one\n');
    writeFileSync(join(clone, 'other.txt'), 'one\n');
    git(clone, ['add', '.']);
    git(clone, ['commit', '--quiet', '-m', 'start']);
    git(clone, ['tag', 'v1.0.0']);
    git(clone, ['switch', '--quiet', '-c', 'bottle']);
    writeFileSync(join(clone, 'app.txt'), 'the batch\n');
    git(clone, ['commit', '--quiet', '-am', 'the batch']);
    head = git(clone, ['rev-parse', 'HEAD']);
    git(clone, ['switch', '--quiet', 'main']);
    writeFileSync(join(clone, 'other.txt'), 'main\n');
    git(clone, ['commit', '--quiet', '-am', 'main elsewhere']);
    tip = git(clone, ['rev-parse', 'HEAD']);
    // A hook of the clone's that would mark the checkout if it ran.
    const hook = join(clone, '.git', 'hooks', 'post-checkout');
    const marker = join(dir.path, 'hook-ran').split('\\').join('/');
    writeFileSync(hook, `#!/bin/sh\necho ran > "${marker}"\n`, {
      mode: 0o755,
    });
  });
  after(() => {
    for (const [name, value] of [
      ['GIT_CONFIG_GLOBAL', machine.global],
      ['GIT_CONFIG_NOSYSTEM', machine.system],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    dir.remove();
  });

  const mergedTree = () =>
    openMergedTree({ git: runGit, clone, own: { url: join(dir.path, 'nowhere.git'), root } });

  it("checks out the merged files, a commit on head and tip with the clone's tags and history, and runs no hook of the clone's", async () => {
    const read = await mergedTree()(head, tip, async (worktree) => ({
      app: readFileSync(join(worktree, 'app.txt'), 'utf8'),
      other: readFileSync(join(worktree, 'other.txt'), 'utf8'),
      parents: git(worktree, ['log', '-1', '--format=%P']),
      describe: git(worktree, ['describe', '--tags', '--abbrev=0']),
      count: git(worktree, ['rev-list', '--count', 'HEAD']),
    }));
    assert.deepStrictEqual(read, {
      app: 'the batch\n',
      other: 'main\n',
      parents: `${head} ${tip}`,
      describe: 'v1.0.0',
      count: '4',
    });
    assert.equal(existsSync(join(dir.path, 'hook-ran')), false);
  });

  it('in a blobless clone, checks out the files with blobs from the URL Foedrum names', async () => {
    git(clone, ['config', 'uploadpack.allowFilter', 'true']);
    const blobless = join(dir.path, 'blobless.git');
    git(dir.path, [
      'clone',
      '--quiet',
      '--bare',
      '--filter=blob:none',
      `file://${clone.split('\\').join('/')}`,
      blobless,
    ]);
    // The clone's remote points nowhere: the blobs come from the URL Foedrum names.
    git(blobless, ['remote', 'set-url', 'origin', join(dir.path, 'nowhere.git')]);
    const url = `file://${clone.split('\\').join('/')}`;
    const read = await openMergedTree({ git: runGit, clone: blobless, own: { url, root } })(
      head,
      tip,
      async (worktree) => [
        readFileSync(join(worktree, 'app.txt'), 'utf8'),
        readFileSync(join(worktree, 'other.txt'), 'utf8'),
      ],
    );
    assert.deepStrictEqual(read, ['the batch\n', 'main\n']);
  });

  it('leaves no worktree or git directory behind, and moves no ref of the clone', async () => {
    const refs = git(clone, ['for-each-ref']);
    await mergedTree()(head, tip, async () => undefined);
    assert.equal(existsSync(root) ? readdirSync(root).length : 0, 0);
    assert.equal(git(clone, ['for-each-ref']), refs);
    assert.doesNotMatch(git(clone, ['worktree', 'list']), /\.tree/);
  });
});
