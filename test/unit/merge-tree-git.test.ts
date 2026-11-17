// The merge-tree of an open pull request's head and its base's tip (ADR 0198), the shell, with a
// fake git that records every call (ADR 0021): it runs in a git directory of Foedrum's own with
// the clone's objects, and reads git's exit code and NUL-separated output.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { devNull } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import type { Git, GitOptions, GitResult } from '../../src/workspace/git.ts';
import {
  openBranchCommit,
  openCommitTree,
  openMergedTree,
  openMergeTree,
} from '../../src/workspace/merge-tree-git.ts';
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

  it('leaves no git directory behind (regression test)', async () => {
    const root = nextFolder();
    const { git, mergeTree } = recordingGit(ok(`${TREE}\0`));
    const merge = openMergeTree({ git, clone, own: { url, root, id: () => 'one' } });
    assert.deepStrictEqual(await merge(HEAD, TIP), { kind: 'clean' });
    assert.match(mergeTree()?.args[0] ?? '', /^--git-dir=.*one\.git$/);
    assert.equal(existsSync(join(root, 'one.git')), false);
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

  it('keeps no ref line with a field after the ref (review of #642, regression test)', async () => {
    const root = nextFolder();
    const listed = `${TAG} refs/tags/v1\n${TAG} refs/tags/v4 extra\n`;
    const { git } = treeGit(ok(`${TREE}\0`), listed);
    const packed = await openMergedTree({ git, clone, own: { url, root, id: () => 'one' } })(
      HEAD,
      TIP,
      async () => readFileSync(join(root, 'one.git', 'packed-refs'), 'utf8'),
    );
    assert.equal(packed, `${TAG} refs/tags/v1\n`);
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

describe('openCommitTree', () => {
  const COMMIT = '9'.repeat(40);

  it('writes no edit through a link the commit holds, and fails before the run (ADR 0313)', async () => {
    const root = nextFolder();
    const outside = nextFolder();
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'add.mjs'), 'outside\n');
    const recorded = recordingGit(ok());
    // The commit's `src` is a link out of the tree: a junction, which Windows makes without a privilege.
    const git: Git = async (cwd, args, options) => {
      const result = await recorded.git(cwd, args, options);
      if (args.includes('worktree') && args.includes('add')) {
        const tree = args.at(-2) ?? '';
        mkdirSync(tree, { recursive: true });
        symlinkSync(outside, join(tree, 'src'), 'junction');
      }
      return result;
    };
    let used = false;
    await assert.rejects(
      openCommitTree({ git, clone, own: { url, root, id: () => 'one' } })(
        COMMIT,
        async () => {
          used = true;
        },
        { edit: { file: 'src/add.mjs', rewrite: () => 'the mutant\n' } },
      ),
      { message: '"src/add.mjs" is no regular file of the scratch tree' },
    );
    assert.equal(used, false);
    assert.equal(readFileSync(join(outside, 'add.mjs'), 'utf8'), 'outside\n');
    assert.equal(existsSync(join(root, 'one.tree')), false);
  });

  it("gives a mutant's rewrite the file as git checked it out (ADR 0313, regression test)", async () => {
    const root = nextFolder();
    const recorded = recordingGit(ok());
    // The checkout writes the commit's text, as git's worktree add would.
    const git: Git = async (cwd, args, options) => {
      const result = await recorded.git(cwd, args, options);
      if (args.includes('worktree') && args.includes('add')) {
        mkdirSync(args.at(-2) ?? '', { recursive: true });
        writeFileSync(join(args.at(-2) ?? '', 'app.txt'), 'the batch\n');
      }
      return result;
    };
    const seen: string[] = [];
    const edit = {
      file: 'app.txt',
      rewrite: (text: string) => {
        seen.push(text);
        return text.replace('the batch', 'the mutant');
      },
    };
    const read = await openCommitTree({ git, clone, own: { url, root, id: () => 'one' } })(
      COMMIT,
      async (worktree) => readFileSync(join(worktree, 'app.txt'), 'utf8'),
      { edit },
    );
    // The commit's text, as the checkout wrote it, and the rewrite of it in the tree.
    assert.deepStrictEqual(seen, ['the batch\n']);
    assert.equal(read, 'the mutant\n');
  });

  it('writes no edit to a file the checked-out tree does not hold (regression test)', async () => {
    const root = nextFolder();
    const recorded = recordingGit(ok());
    const git: Git = async (cwd, args, options) => {
      const result = await recorded.git(cwd, args, options);
      if (args.includes('worktree') && args.includes('add')) {
        mkdirSync(args.at(-2) ?? '', { recursive: true });
      }
      return result;
    };
    let used = false;
    await assert.rejects(
      openCommitTree({ git, clone, own: { url, root, id: () => 'one' } })(
        COMMIT,
        async () => {
          used = true;
        },
        { edit: { file: 'src/gone.mjs', rewrite: () => 'the mutant' } },
      ),
      { message: '"src/gone.mjs" is no regular file of the scratch tree' },
    );
    assert.equal(used, false);
    assert.equal(existsSync(join(root, 'one.tree', 'src', 'gone.mjs')), false);
  });

  it('writes no edit to a file that is not UTF-8, whose other bytes a rewrite would change (ADR 0313)', async () => {
    const root = nextFolder();
    // Latin-1 "café" and a line feed: 0xE9 is no UTF-8 on its own.
    const latin1 = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]);
    const recorded = recordingGit(ok());
    let file = '';
    const git: Git = async (cwd, args, options) => {
      const result = await recorded.git(cwd, args, options);
      if (args.includes('worktree') && args.includes('add')) {
        const tree = args.at(-2) ?? '';
        mkdirSync(join(tree, 'src'), { recursive: true });
        file = join(tree, 'src', 'add.mjs');
        writeFileSync(file, latin1);
      }
      return result;
    };
    let used = false;
    await assert.rejects(
      openCommitTree({ git, clone, own: { url, root, id: () => 'one' } })(
        COMMIT,
        async () => {
          used = true;
        },
        { edit: { file: 'src/add.mjs', rewrite: (text) => text } },
      ),
      { message: '"src/add.mjs" is not UTF-8: a rewrite would change more than its line' },
    );
    assert.equal(used, false);
  });
});

describe('openBranchCommit (ADR 0412)', () => {
  const BRANCH = 'foedrum/12-1/implement/1';
  const BLOB = '1'.repeat(40);
  const NEW_TREE = '2'.repeat(40);
  const NEW_COMMIT = '3'.repeat(40);

  /** A git that names TIP as the branch's tip and answers the plumbing with distinct shas. */
  /** The mode the tip's tree gives the lockfile, as `ls-files -s` names it. */
  const branchGit = (mode = '100644') => {
    const recorded = recordingGit(ok());
    const git: Git = async (cwd, args, options) => {
      const result = await recorded.git(cwd, args, options);
      if (args.includes('rev-parse') && args.includes(`refs/heads/${BRANCH}^{commit}`)) {
        return ok(`${TIP}\n`);
      }
      if (args.includes('ls-files')) {
        return ok(`${mode} ${'4'.repeat(40)} 0\tweb/package-lock.json\n`);
      }
      if (args.includes('hash-object')) return ok(`${BLOB}\n`);
      if (args.includes('write-tree')) return ok(`${NEW_TREE}\n`);
      if (args.includes('commit-tree')) return ok(`${NEW_COMMIT}\n`);
      return result;
    };
    const call = (command: string) => recorded.calls.find(({ args }) => args.includes(command));
    return { git, calls: recorded.calls, call };
  };

  it("commits the files it names on the branch's tip as Foedrum, and moves the branch only from that tip", async () => {
    const { git, call } = branchGit();
    const commit = openBranchCommit({
      git,
      clone,
      own: { url, root: nextFolder(), id: () => 'one' },
    });
    const seen: string[] = [];
    const done = await commit(BRANCH, 'Refresh the lockfile', async (worktree) => {
      seen.push(worktree);
      return { value: 'refreshed', files: ['web/package-lock.json'] };
    });
    assert.deepStrictEqual(done, { value: 'refreshed', commit: NEW_COMMIT });
    // The tree checked out is the tip's, and the lockfile goes onto that tip's tree.
    assert.equal(call('worktree')?.args.at(-1), TIP);
    assert.match(seen[0] ?? '', /one\.tree$/);
    const read = call('read-tree');
    assert.equal(read?.args.at(-1), TIP);
    const index = read?.options?.env?.GIT_INDEX_FILE;
    assert.ok(index !== undefined);
    // Hashed inside the tree, through the tree's git directory as Foedrum names it, so the tree's
    // .gitattributes take part.
    const hashed = call('hash-object');
    assert.equal(hashed?.cwd, seen[0]);
    assert.equal(
      hashed?.args[0],
      `--git-dir=${join(dirname(seen[0] ?? ''), 'one.git', 'worktrees', 'one.tree')}`,
    );
    assert.equal(hashed?.args.at(-1), 'web/package-lock.json');
    assert.deepStrictEqual(call('update-index')?.args.slice(-3), [
      '--add',
      '--cacheinfo',
      `100644,${BLOB},web/package-lock.json`,
    ]);
    assert.equal(call('update-index')?.options?.env?.GIT_INDEX_FILE, index);
    assert.equal(call('write-tree')?.options?.env?.GIT_INDEX_FILE, index);
    const made = call('commit-tree');
    assert.deepStrictEqual(made?.args.slice(-5), [
      NEW_TREE,
      '-p',
      TIP,
      '-m',
      'Refresh the lockfile',
    ]);
    assert.equal(made?.options?.env?.GIT_AUTHOR_NAME, 'Foedrum');
    // In the clone, with none of its hooks, from the tip only.
    const moved = call('update-ref');
    assert.equal(moved?.cwd, clone);
    assert.equal(moved?.options?.config?.['core.hooksPath'], devNull);
    assert.deepStrictEqual(moved?.args.slice(-3), [`refs/heads/${BRANCH}`, NEW_COMMIT, TIP]);
  });

  it('keeps the mode the tip gives the file, such as an executable lockfile', async () => {
    const { git, call } = branchGit('100755');
    const commit = openBranchCommit({
      git,
      clone,
      own: { url, root: nextFolder(), id: () => 'one' },
    });
    const done = await commit(BRANCH, 'Refresh', async () => ({
      value: 1,
      files: ['web/package-lock.json'],
    }));
    assert.deepStrictEqual(done, { value: 1, commit: NEW_COMMIT });
    assert.equal(call('update-index')?.args.at(-1), `100755,${BLOB},web/package-lock.json`);
  });

  it('commits no file the tip holds as a link, which a checkout without symlinks wrote as a file', async () => {
    const { git, calls } = branchGit('120000');
    const commit = openBranchCommit({
      git,
      clone,
      own: { url, root: nextFolder(), id: () => 'one' },
    });
    const done = await commit(BRANCH, 'Refresh', async () => ({
      value: 1,
      files: ['web/package-lock.json'],
    }));
    assert.deepStrictEqual(done, { value: 1 });
    // It read the tip's tree, and wrote nothing from it.
    assert.ok(calls.some(({ args }) => args.includes('ls-files')));
    for (const command of ['hash-object', 'commit-tree', 'update-ref']) {
      assert.equal(
        calls.some(({ args }) => args.includes(command)),
        false,
        command,
      );
    }
  });

  it('commits nothing and leaves the branch where it is when it names no file', async () => {
    const { git, calls } = branchGit();
    const commit = openBranchCommit({
      git,
      clone,
      own: { url, root: nextFolder(), id: () => 'one' },
    });
    const done = await commit(BRANCH, 'Refresh the lockfile', async () => ({
      value: 1,
      files: [],
    }));
    assert.deepStrictEqual(done, { value: 1 });
    // It did check the tip out.
    assert.ok(calls.some(({ args }) => args.includes('worktree')));
    for (const command of ['hash-object', 'commit-tree', 'update-ref']) {
      assert.equal(
        calls.some(({ args }) => args.includes(command)),
        false,
        command,
      );
    }
  });

  it('refuses a branch that is no attempt branch, before git runs', async () => {
    const { git, calls } = branchGit();
    const commit = openBranchCommit({
      git,
      clone,
      own: { url, root: nextFolder(), id: () => 'one' },
    });
    await assert.rejects(
      commit('--output=x', 'Refresh', async () => ({ value: 1, files: [] })),
      /"--output=x" is no attempt branch/,
    );
    assert.deepStrictEqual(calls, []);
  });
});
