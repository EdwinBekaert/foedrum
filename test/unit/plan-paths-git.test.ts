// The paths of a plan read at a commit (ADR 0233) with a fake git: the calls it makes and what it
// reads from them. Real git is in test/integration/plan-paths.test.ts.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Git } from '../../src/workspace/git.ts';
import { readPathsAt } from '../../src/workspace/plan-paths-git.ts';

const commit = 'c'.repeat(40);

/** A git that lists each path it is asked for that `has` holds, and records each call. */
const fakeGit = (has: (path: string) => boolean) => {
  const calls: { args: readonly string[]; env: unknown }[] = [];
  const git: Git = async (_cwd, args, options = {}) => {
    calls.push({ args, env: options.env });
    const asked = args.slice(args.indexOf('--') + 1);
    return {
      code: 0,
      stdout: asked
        .filter(has)
        .map((path) => `${path}\0`)
        .join(''),
      stderr: '',
    };
  };
  return { calls, git };
};

describe('readPathsAt (ADR 0233, regression tests)', () => {
  it('reads paths past 24,000 characters in a second call, and keeps what each found', async () => {
    // 100 paths of 300 characters: 30,100 with their separators.
    const paths = Array.from(
      { length: 100 },
      (_, i) => `${String(i).padStart(3, '0')}${'p'.repeat(297)}`,
    );
    const { calls, git } = fakeGit((path) => path.startsWith('00') || path.startsWith('09'));
    const read = await readPathsAt(git)('/work/api.git', commit, paths);
    assert.deepEqual(
      calls.map(({ args }) => args.slice(0, 6)),
      [
        ['ls-tree', '-t', '--name-only', '-z', commit, '--'],
        ['ls-tree', '-t', '--name-only', '-z', commit, '--'],
      ],
    );
    for (const { args } of calls) assert.ok(args.slice(6).join(' ').length <= 24_000);
    assert.deepEqual(
      calls.flatMap(({ args }) => args.slice(6)),
      paths,
    );
    assert.deepEqual(
      calls.map(({ env }) => env),
      [{ GIT_LITERAL_PATHSPECS: '1' }, { GIT_LITERAL_PATHSPECS: '1' }],
    );
    assert.deepEqual(read.kind === 'read' ? [...read.present] : read, [
      ...paths.slice(0, 10),
      ...paths.slice(90),
    ]);
  });

  it('refuses a path that is no relative path, and a commit that is no full sha, before git runs', async () => {
    const { calls, git } = fakeGit(() => true);
    assert.deepEqual(await readPathsAt(git)('/work/api.git', commit, ['src', '../x']), {
      kind: 'unread',
      reason: '"../x" is no relative path',
    });
    assert.deepEqual(await readPathsAt(git)('/work/api.git', 'HEAD', ['src']), {
      kind: 'unread',
      reason: 'HEAD is no full commit sha',
    });
    assert.deepEqual(calls, []);
  });

  it('is unread with the first line git said when ls-tree fails', async () => {
    const git: Git = async () => ({ code: 128, stdout: '', stderr: 'fatal: not a tree object\n' });
    assert.deepEqual(await readPathsAt(git)('/work/api.git', commit, ['src']), {
      kind: 'unread',
      reason: 'git ls-tree failed: fatal: not a tree object',
    });
  });
});
