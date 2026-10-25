// The merge-tree of an open pull request's head and its base's tip (ADR 0198), the shell, with a
// fake git that records every call (ADR 0021): it runs in a git directory of Foedrum's own with
// the clone's objects, reads git's exit code and NUL-separated output, and runs only on a git that
// has `--write-tree`.

import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { devNull } from 'node:os';
import { describe, it } from 'node:test';
import type { Git, GitOptions, GitResult } from '../../src/workspace/git.ts';
import { mergeTreeSupported, openMergeTree } from '../../src/workspace/merge-tree-git.ts';
import { suiteFolders } from '../helpers/attempt-worktrees.ts';

const HEAD = 'a'.repeat(40);
const TIP = 'c'.repeat(40);
const TREE = 'f'.repeat(40);
const clone = '/work/acme.api/clone';
const url = 'https://github.com/acme/api.git';
const nextFolder = suiteFolders('merge-tree-git');

const ok = (stdout = ''): GitResult => ({ code: 0, stdout, stderr: '' });
const exited = (code: number, stdout = '', stderr = ''): GitResult => ({ code, stdout, stderr });

/** A git that answers the merge-tree with `merged`, and makes the git directory init names. */
const recordingGit = (merged: GitResult, partial = false) => {
  const calls: { cwd: string; args: readonly string[]; options: GitOptions | undefined }[] = [];
  const git: Git = async (cwd, args, options) => {
    calls.push({ cwd, args, options });
    if (args[1] === 'init' && args[0]?.startsWith('--git-dir=')) {
      mkdirSync(args[0].slice('--git-dir='.length), { recursive: true });
    }
    if (args.includes('--show-object-format')) return ok(`${clone}\nsha1\n`);
    if (args[0] === 'config' && args[1] === '--get-regexp') {
      return partial ? ok('remote.origin.promisor true\n') : exited(1);
    }
    if (args.includes('merge-tree')) return merged;
    return ok();
  };
  const mergeTree = () => calls.find(({ args }) => args.includes('merge-tree'));
  return { git, calls, mergeTree };
};

const open = (git: Git) =>
  openMergeTree({ git, clone, own: { url, root: nextFolder(), id: () => 'one' } });

describe('openMergeTree', () => {
  it("merge-trees in a git directory of its own with the clone's objects, no hook or gc", async () => {
    const { git, mergeTree } = recordingGit(ok(`${TREE}\0`));
    assert.deepStrictEqual(await open(git)(HEAD, TIP), { kind: 'clean' });
    const call = mergeTree();
    assert.ok(call);
    assert.match(call.args[0] ?? '', /^--git-dir=.*one\.git$/);
    assert.deepStrictEqual(call.args.slice(1), [
      'merge-tree',
      '--write-tree',
      '--name-only',
      '--no-messages',
      '-z',
      '--end-of-options',
      HEAD,
      TIP,
    ]);
    assert.equal(call.options?.env?.GIT_OBJECT_DIRECTORY?.endsWith('objects'), true);
    assert.equal(call.options?.config?.['core.hooksPath'], devNull);
    assert.equal(call.options?.config?.['gc.auto'], '0');
  });

  it('lists the files of a conflict once each, in the order git names them', async () => {
    const { git } = recordingGit(exited(1, `${TREE}\0src/a.ts\0src/b.ts\0src/a.ts\0`));
    assert.deepStrictEqual(await open(git)(HEAD, TIP), {
      kind: 'conflicts',
      files: ['src/a.ts', 'src/b.ts'],
    });
  });

  it('fails when git does, or when a conflict names no file', async () => {
    const broken = recordingGit(exited(128, '', 'fatal: bad object cccc\n'));
    await assert.rejects(open(broken.git)(HEAD, TIP), {
      message: 'git merge-tree failed: fatal: bad object cccc',
    });
    const empty = recordingGit(exited(1, `${TREE}\0`));
    await assert.rejects(open(empty.git)(HEAD, TIP), /git merge-tree named no conflicting file/);
  });

  it('refuses a head or a tip that is no full sha, before git runs', async () => {
    const { git, calls } = recordingGit(ok(`${TREE}\0`));
    await assert.rejects(open(git)('--output=x', TIP), /is no full commit sha/);
    await assert.rejects(open(git)(HEAD, 'main'), /is no full commit sha/);
    assert.deepStrictEqual(calls, []);
  });

  it("in a blobless clone, a missing blob comes from the URL Foedrum names, never the clone's remote", async () => {
    const { git, mergeTree } = recordingGit(ok(`${TREE}\0`), true);
    await open(git)(HEAD, TIP);
    const config = mergeTree()?.options?.config ?? {};
    assert.equal(config['remote.foedrum.url'], url);
    assert.equal(config['remote.foedrum.promisor'], 'true');
  });
});

describe('mergeTreeSupported', () => {
  const answering =
    (result: GitResult): Git =>
    async () =>
      result;
  it('is true from git 2.38 on, false before it, and unknown when git names no version', async () => {
    const cases: [GitResult, boolean | undefined][] = [
      [ok('git version 2.38.0\n'), true],
      [ok('git version 2.56.0.windows.2\n'), true],
      [ok('git version 3.0.1\n'), true],
      [ok('git version 2.37.9\n'), false],
      [ok('git version 2.31.0\n'), false],
      [exited(1, '', 'not git'), undefined],
      [ok('something else'), undefined],
    ];
    for (const [result, supported] of cases) {
      assert.equal(await mergeTreeSupported(answering(result), clone), supported, result.stdout);
    }
  });
});
