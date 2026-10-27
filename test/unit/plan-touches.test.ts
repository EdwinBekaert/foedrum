import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Ending } from '../../src/engine/decide.ts';
import {
  type PathsRead,
  type PlanRepository,
  touchesChecked,
} from '../../src/engine/plan-touches.ts';

const api = 'a'.repeat(40);
const web = 'b'.repeat(40);
const repositories: PlanRepository[] = [
  { repo: 'acme/api', clone: '/work/api.git', commit: api },
  { repo: 'acme/web', clone: '/work/web.git', commit: web },
];

const subOrder = (id: string, repo: string, touches: { path: string; new?: true }[]) => ({
  id,
  title: `Build ${id}`,
  repo,
  size: { lines: 100, mechanism: 'one change' },
  doneWhen: 'a test passes',
  touches,
  dependencies: [],
  recipe: 'tdd',
  why: 'testable',
  ready: true,
});

const succeeded = (...subOrders: unknown[]): Ending => ({
  kind: 'succeeded',
  output: JSON.parse(
    JSON.stringify({ status: 'done', summary: 'A plan', assumptions: [], subOrders }),
  ),
});

/** A fake read: the paths each clone has, and every call it was given. */
const reader = (has: Record<string, string[]>, unread?: string) => {
  const calls: { clone: string; commit: string; paths: readonly string[] }[] = [];
  const read = async (clone: string, commit: string, paths: readonly string[]) => {
    calls.push({ clone, commit, paths });
    if (unread !== undefined) return { kind: 'unread', reason: unread } satisfies PathsRead;
    const present = new Set(paths.filter((path) => has[clone]?.includes(path)));
    return { kind: 'read', present } satisfies PathsRead;
  };
  return { calls, read };
};

describe('touchesChecked (ADR 0233)', () => {
  it('reads each repository once at its commit, only the paths not marked new, and keeps the ending when every one exists', async () => {
    const { calls, read } = reader({
      '/work/api.git': ['src/server.ts', 'src'],
      '/work/web.git': ['app/page.tsx'],
    });
    const ending = succeeded(
      subOrder('api', 'acme/api', [{ path: 'src/server.ts' }, { path: 'src/new.ts', new: true }]),
      subOrder('cli', 'ACME/api', [{ path: 'src' }]),
      subOrder('ui', 'acme/web', [{ path: 'app/page.tsx' }]),
    );
    assert.deepEqual(await touchesChecked(read, ending, repositories), ending);
    assert.deepEqual(calls, [
      { clone: '/work/api.git', commit: api, paths: ['src/server.ts', 'src'] },
      { clone: '/work/web.git', commit: web, paths: ['app/page.tsx'] },
    ]);
  });

  it('fails retryably on a path that does not exist, naming the sub-order, the path, the repository and the commit', async () => {
    const { read } = reader({ '/work/api.git': ['src/server.ts'] });
    const ending = succeeded(
      subOrder('api', 'acme/api', [{ path: 'src/server.ts' }, { path: 'src/gone.ts' }]),
    );
    assert.deepEqual(await touchesChecked(read, ending, repositories), {
      kind: 'failed',
      retryable: true,
      reason:
        'the plan touches paths that do not exist; mark a path new: true when its sub-order creates it (ADR 0233): sub-order api, src/gone.ts in acme/api at aaaaaaaaaaaa',
    });
  });

  it('names three missing paths and counts the rest', async () => {
    const { read } = reader({});
    const ending = succeeded(
      subOrder('api', 'acme/api', [{ path: 'a' }, { path: 'b' }, { path: 'c' }, { path: 'd' }]),
      subOrder('ui', 'acme/web', [{ path: 'e' }]),
    );
    const checked = await touchesChecked(read, ending, repositories);
    assert.equal(checked.kind, 'failed');
    assert.match(
      checked.kind === 'failed' ? checked.reason : '',
      /: sub-order api, a in acme\/api at a{12}; sub-order api, b in acme\/api at a{12}; sub-order api, c in acme\/api at a{12}; and 2 more$/,
    );
  });

  it('passes a path marked new that does not exist, and one that does', async () => {
    const { calls, read } = reader({ '/work/api.git': ['src/there.ts'] });
    const ending = succeeded(
      subOrder('api', 'acme/api', [
        { path: 'src/there.ts', new: true },
        { path: 'src/fresh.ts', new: true },
      ]),
    );
    assert.deepEqual(await touchesChecked(read, ending, repositories), ending);
    assert.deepEqual(calls, []);
  });

  it('fails retryably on a repository the Brewery does not list, before any read', async () => {
    const { calls, read } = reader({});
    const ending = succeeded(subOrder('db', 'acme/db', [{ path: 'schema.sql' }]));
    assert.deepEqual(await touchesChecked(read, ending, repositories), {
      kind: 'failed',
      retryable: true,
      reason:
        'the plan names repositories the Brewery does not list (ADR 0233): sub-order db, acme/db',
    });
    assert.deepEqual(calls, []);
  });

  it('blocks on the environment when git could not read the paths, also when the read throws', async () => {
    const ending = succeeded(subOrder('api', 'acme/api', [{ path: 'src/server.ts' }]));
    const { read } = reader({}, 'git ls-tree failed: fatal: not a tree object');
    const blocked = {
      kind: 'blocked',
      blockerKind: 'environment',
      summary: `the plan's paths in acme/api at aaaaaaa were not read: git ls-tree failed: fatal: not a tree object`,
    };
    assert.deepEqual(await touchesChecked(read, ending, repositories), blocked);
    const throwing = async (): Promise<PathsRead> => {
      throw new Error('git ls-tree failed: fatal: not a tree object');
    };
    assert.deepEqual(await touchesChecked(throwing, ending, repositories), blocked);
  });

  it('leaves any other ending, an out doc that is no plan, and an attempt without repositories as they are', async () => {
    const { calls, read } = reader({});
    const failed: Ending = { kind: 'failed', retryable: true, reason: 'no luck' };
    assert.deepEqual(await touchesChecked(read, failed, repositories), failed);
    const other: Ending = {
      kind: 'succeeded',
      output: { status: 'done', summary: 'Fixed', assumptions: [] },
    };
    assert.deepEqual(await touchesChecked(read, other, repositories), other);
    const plan = succeeded(subOrder('api', 'acme/api', [{ path: 'gone' }]));
    assert.deepEqual(await touchesChecked(read, plan, undefined), plan);
    assert.deepEqual(calls, []);
  });
});
