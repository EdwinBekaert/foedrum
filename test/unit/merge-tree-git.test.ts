// The merge-tree of an open pull request's head and its base's tip (ADR 0198), the shell, with a
// fake git that records every call (ADR 0021): it runs in a git directory of Foedrum's own with
// the clone's objects, and reads git's exit code and NUL-separated output.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { devNull } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { Git, GitOptions, GitResult } from '../../src/workspace/git.ts';
import { openMergedTree, openMergeTree } from '../../src/workspace/merge-tree-git.ts';
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

describe('openMergedTree', () => {
  const COMMIT = '9'.repeat(40);
  const TAG = '7'.repeat(40);
  const MAIN = '6'.repeat(40);

  /** A git that merges cleanly, makes the commit and the worktree, and lists the clone's refs. */
  const treeGit = (
    merged: GitResult = ok(`${TREE}\0`),
    refs = `${TAG} refs/tags/v1.0.0\n${MAIN} refs/remotes/origin/main\n`,
  ) => {
    const recorded = recordingGit(merged);
    const git: Git = async (cwd, args, options) => {
      const result = await recorded.git(cwd, args, options);
      if (args.includes('commit-tree')) return ok(`${COMMIT}\n`);
      if (args[0] === 'for-each-ref') return ok(refs);
      const add = args.indexOf('add');
      if (args.includes('worktree') && add !== -1) {
        mkdirSync(args.at(-2) ?? '', { recursive: true });
      }
      return result;
    };
    return { ...recorded, git };
  };
  const call = (calls: ReturnType<typeof recordingGit>['calls'], word: string) =>
    calls.find(({ args }) => args.includes(word));

  it('commits the merged tree on head and tip and checks it out from its own git directory, then removes both', async () => {
    const root = nextFolder();
    const { git, calls } = treeGit();
    let seen: { tree: string; packed: string; alternates: string } | undefined;
    const read = await openMergedTree({ git, clone, own: { url, root, id: () => 'one' } })(
      HEAD,
      TIP,
      async (worktree) => {
        seen = {
          tree: worktree,
          packed: readFileSync(join(root, 'one.git', 'packed-refs'), 'utf8'),
          alternates: readFileSync(join(root, 'one.git', 'objects', 'info', 'alternates'), 'utf8'),
        };
        return 'read';
      },
    );
    assert.equal(read, 'read');
    assert.equal(seen?.tree, join(root, 'one.tree'));
    const commit = call(calls, 'commit-tree');
    assert.deepStrictEqual(commit?.args.slice(1, 7), ['commit-tree', TREE, '-p', HEAD, '-p', TIP]);
    // Foedrum's own name: the user's configuration need not name one.
    assert.equal(commit?.options?.env?.GIT_AUTHOR_NAME, 'Foedrum');
    assert.equal(commit?.options?.env?.GIT_COMMITTER_NAME, 'Foedrum');
    const add = call(calls, 'worktree');
    assert.match(add?.args[0] ?? '', /^--git-dir=.*one\.git$/);
    assert.deepStrictEqual(add?.args.slice(1), [
      'worktree',
      'add',
      '--quiet',
      '--detach',
      '--end-of-options',
      join(root, 'one.tree'),
      COMMIT,
    ]);
    assert.equal(add?.options?.config?.['core.hooksPath'], devNull);
    // The clone's tags and remote-tracking refs, read with no hook or fsmonitor of the clone's.
    const refs = call(calls, 'for-each-ref');
    assert.equal(refs?.cwd, clone);
    assert.equal(refs?.options?.config?.['core.hooksPath'], devNull);
    assert.equal(seen?.packed, `${TAG} refs/tags/v1.0.0\n${MAIN} refs/remotes/origin/main\n`);
    assert.equal(seen?.alternates, `${join(clone, 'objects')}\n`);
    assert.equal(existsSync(join(root, 'one.tree')), false);
    assert.equal(existsSync(join(root, 'one.git')), false);
  });

  it('keeps only the refs it can read as a commit and a tag or remote-tracking ref', async () => {
    const root = nextFolder();
    // A SHA-256 id is no commit Foedrum reads (ADR 0254).
    const listed = `${TAG} refs/tags/v1\nnot-a-sha refs/tags/v2\n${'d'.repeat(64)} refs/tags/v3\n${MAIN} refs/heads/main\n${MAIN} refs/remotes/origin/main\n`;
    const { git } = treeGit(ok(`${TREE}\0`), listed);
    const packed = await openMergedTree({ git, clone, own: { url, root, id: () => 'one' } })(
      HEAD,
      TIP,
      async () => readFileSync(join(root, 'one.git', 'packed-refs'), 'utf8'),
    );
    assert.equal(packed, `${TAG} refs/tags/v1\n${MAIN} refs/remotes/origin/main\n`);
  });

  it('removes the worktree and the directory when the read fails, and fails with it', async () => {
    const root = nextFolder();
    const { git } = treeGit();
    await assert.rejects(
      openMergedTree({ git, clone, own: { url, root, id: () => 'one' } })(HEAD, TIP, async () => {
        throw new Error('read failed');
      }),
      { message: 'read failed' },
    );
    assert.equal(existsSync(join(root, 'one.tree')), false);
    assert.equal(existsSync(join(root, 'one.git')), false);
  });

  it('fails without a read when the worktree cannot be added, and removes both', async () => {
    const root = nextFolder();
    const recorded = treeGit();
    const git: Git = async (cwd, args, options) =>
      args.includes('worktree')
        ? exited(128, '', 'fatal: could not create work tree dir\n')
        : recorded.git(cwd, args, options);
    let used = false;
    await assert.rejects(
      openMergedTree({ git, clone, own: { url, root, id: () => 'one' } })(HEAD, TIP, async () => {
        used = true;
      }),
      { message: 'git worktree add failed: fatal: could not create work tree dir' },
    );
    assert.equal(used, false);
    assert.equal(existsSync(join(root, 'one.tree')), false);
    assert.equal(existsSync(join(root, 'one.git')), false);
  });

  it('fails without a read when the merge conflicts now, or git fails', async () => {
    const conflicted = treeGit(exited(1, `${TREE}\0src/a.ts\0`));
    let used = false;
    const use = async () => {
      used = true;
    };
    await assert.rejects(open2(conflicted.git)(HEAD, TIP, use), /conflicts in src\/a\.ts/);
    const broken = treeGit(exited(128, '', 'fatal: bad object cccc\n'));
    await assert.rejects(
      open2(broken.git)(HEAD, TIP, use),
      /git merge-tree failed: fatal: bad object/,
    );
    assert.equal(used, false);
  });

  const open2 = (git: Git) =>
    openMergedTree({ git, clone, own: { url, root: nextFolder(), id: () => 'one' } });
});
