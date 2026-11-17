// The files a Taster's findings cite, read at the commit it reviewed (ADR 0421), with a fake git: the
// calls it makes and what it reads from them. Real git is in test/integration/finding-files.test.ts.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFilesAt } from '../../src/workspace/finding-files-git.ts';
import type { Git, GitResult } from '../../src/workspace/git.ts';

const commit = 'c'.repeat(40);
const blob = (n: number): string => String(n).repeat(40);

/** A git that lists `entries` (path to mode, type and object) for ls-tree and gives `texts` by object. */
const fakeGit = (
  entries: Record<string, [string, string, string]>,
  texts: Record<string, string>,
  fails: { lsTree?: GitResult; catFile?: GitResult } = {},
) => {
  const calls: { cwd: string; args: readonly string[]; env: unknown }[] = [];
  const git: Git = async (cwd, args, options = {}) => {
    calls.push({ cwd, args, env: options.env });
    if (args[0] === 'ls-tree') {
      if (fails.lsTree !== undefined) return fails.lsTree;
      const asked = args.slice(args.indexOf('--') + 1);
      const stdout = asked
        .flatMap((path) => {
          const entry = entries[path];
          return entry === undefined ? [] : [`${entry[0]} ${entry[1]} ${entry[2]}\t${path}\0`];
        })
        .join('');
      return { code: 0, stdout, stderr: '' };
    }
    if (fails.catFile !== undefined) return fails.catFile;
    return { code: 0, stdout: texts[args.at(-1) ?? ''] ?? '', stderr: '' };
  };
  return { calls, git };
};

describe('readFilesAt (ADR 0421)', () => {
  it('lists the paths at the commit with literal pathspecs and reads each file by its object, in the clone', async () => {
    const { calls, git } = fakeGit(
      { 'src/a.ts': ['100644', 'blob', blob(1)], '[x].md': ['100755', 'blob', blob(2)] },
      { [blob(1)]: 'a\nb\n', [blob(2)]: '# x\n' },
    );
    const read = await readFilesAt(git)('/work/api.git', commit, ['src/a.ts', '[x].md']);
    assert.deepEqual(read, {
      kind: 'read',
      files: new Map([
        ['src/a.ts', 'a\nb\n'],
        ['[x].md', '# x\n'],
      ]),
    });
    assert.deepEqual(
      calls.map(({ cwd, args }) => ({ cwd, args })),
      [
        { cwd: '/work/api.git', args: ['ls-tree', '-z', commit, '--', 'src/a.ts', '[x].md'] },
        { cwd: '/work/api.git', args: ['cat-file', 'blob', blob(1)] },
        { cwd: '/work/api.git', args: ['cat-file', 'blob', blob(2)] },
      ],
    );
    assert.deepEqual(calls[0]?.env, { GIT_LITERAL_PATHSPECS: '1' });
  });

  it('gives no text for a missing path, a folder, a link and a submodule, and reads none of them', async () => {
    const { calls, git } = fakeGit(
      {
        src: ['040000', 'tree', blob(3)],
        'src/link.ts': ['120000', 'blob', blob(4)],
        vendor: ['160000', 'commit', blob(5)],
      },
      {},
    );
    const paths = ['src/gone.ts', 'src', 'src/link.ts', 'vendor'];
    const read = await readFilesAt(git)('/work/api.git', commit, paths);
    assert.deepEqual(read, {
      kind: 'read',
      files: new Map(paths.map((path) => [path, undefined])),
    });
    assert.deepEqual(
      calls.map(({ args }) => args[0]),
      ['ls-tree'],
    );
  });

  it('gives no text for a path that is no relative path, without asking git for it, and still reads the others', async () => {
    const { calls, git } = fakeGit(
      { 'src/a.ts': ['100644', 'blob', blob(1)] },
      { [blob(1)]: 'a\n' },
    );
    const read = await readFilesAt(git)('/work/api.git', commit, ['C:/x.ts', 'src/a.ts']);
    assert.deepEqual(read, {
      kind: 'read',
      files: new Map([
        ['C:/x.ts', undefined],
        ['src/a.ts', 'a\n'],
      ]),
    });
    assert.deepEqual(calls[0]?.args, ['ls-tree', '-z', commit, '--', 'src/a.ts']);
  });

  it('reads a plain path that is no name Windows takes, such as aux.c or a trailing dot, which git holds on Linux', async () => {
    const { calls, git } = fakeGit(
      {
        'drivers/aux.c': ['100644', 'blob', blob(1)],
        'docs/notes.': ['100644', 'blob', blob(2)],
      },
      { [blob(1)]: 'int x;\n', [blob(2)]: 'notes\n' },
    );
    const paths = ['drivers/aux.c', 'docs/notes.'];
    const read = await readFilesAt(git)('/work/api.git', commit, paths);
    assert.deepEqual(read, {
      kind: 'read',
      files: new Map([
        ['drivers/aux.c', 'int x;\n'],
        ['docs/notes.', 'notes\n'],
      ]),
    });
    assert.deepEqual(calls[0]?.args, ['ls-tree', '-z', commit, '--', ...paths]);
  });

  it('is unread when ls-tree fails', async () => {
    const { git } = fakeGit(
      {},
      {},
      { lsTree: { code: 128, stdout: '', stderr: 'fatal: bad object' } },
    );
    assert.deepEqual(await readFilesAt(git)('/work/api.git', commit, ['src/a.ts']), {
      kind: 'unread',
      reason: 'git ls-tree failed: fatal: bad object',
    });
  });

  it('is unread when cat-file fails', async () => {
    const { git } = fakeGit(
      { 'src/a.ts': ['100644', 'blob', blob(1)] },
      {},
      { catFile: { code: 128, stdout: '', stderr: 'fatal: missing blob' } },
    );
    assert.deepEqual(await readFilesAt(git)('/work/api.git', commit, ['src/a.ts']), {
      kind: 'unread',
      reason: 'git cat-file failed: fatal: missing blob',
    });
  });

  it('refuses a commit that is no full sha before git runs', async () => {
    const { calls, git } = fakeGit({}, {});
    const read = await readFilesAt(git)('/work/api.git', '--output=x', ['src/a.ts']);
    assert.equal(read.kind, 'unread');
    assert.deepEqual(calls, []);
  });
});
