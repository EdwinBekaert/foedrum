import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  checkLockfile,
  checkPublishDates,
  type LockEntry,
  type Lockfile,
  type Policy,
  parseLockfile,
  readPolicy,
} from '../../scripts/check-deps.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';

const root = join(import.meta.dirname, '..', '..');
const script = join(root, 'scripts', 'check-deps.ts');

const registry = 'https://registry.npmjs.org';
const DAY = 24 * 60 * 60 * 1000;

const entry = (name: string, version: string, extra: Partial<LockEntry> = {}): LockEntry => {
  const file = name.split('/').pop();
  return {
    version,
    resolved: `${registry}/${name}/-/${file}-${version}.tgz`,
    integrity: `sha512-${'A'.repeat(86)}==`,
    ...extra,
  };
};

interface Direct {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const lockOf = (direct: Direct, entries: Record<string, LockEntry>): Lockfile => ({
  packages: {
    '': { name: 'demo', version: '0.0.0', ...direct },
    ...Object.fromEntries(Object.entries(entries).map(([key, e]) => [`node_modules/${key}`, e])),
  },
});

const okLock = (): Lockfile =>
  lockOf(
    { dependencies: { zod: '4.6.5' }, devDependencies: { typescript: '7.0.2' } },
    { zod: entry('zod', '4.6.5'), typescript: entry('typescript', '7.0.2') },
  );

const policy: Policy = {
  runtimeBudget: 2,
  totalBudget: 10,
  admitted: new Set(['zod', 'typescript']),
  minReleaseAgeDays: 7,
};

describe('checkLockfile', () => {
  it('passes a lockfile of admitted registry packages', () => {
    assert.deepEqual(checkLockfile(okLock(), policy), []);
  });

  it('reports a resolved URL outside the npm registry', () => {
    const lock = okLock();
    lock.packages['node_modules/zod'] = entry('zod', '4.6.5', {
      resolved: 'https://evil.example/zod-4.6.5.tgz',
    });
    const problems = checkLockfile(lock, policy);
    assert.equal(problems.length, 1);
    assert.match(problems[0] ?? '', /node_modules\/zod.*registry/);
  });

  for (const [name, resolved] of [
    [
      'a host that only starts like the registry',
      'https://registry.npmjs.org.evil.example/zod.tgz',
    ],
    ['plain http', 'http://registry.npmjs.org/zod/-/zod-4.6.5.tgz'],
    ['a git URL', 'git+https://github.com/colinhacks/zod.git#abc'],
    ['a local file', 'file:../zod'],
  ] as const) {
    it(`reports ${name} as not the registry`, () => {
      const lock = okLock();
      lock.packages['node_modules/zod'] = entry('zod', '4.6.5', { resolved });
      assert.equal(checkLockfile(lock, policy).length, 1);
    });
  }

  it('reports an entry without a resolved URL', () => {
    const lock = okLock();
    const { resolved: _, ...rest } = entry('zod', '4.6.5');
    lock.packages['node_modules/zod'] = rest;
    assert.match(checkLockfile(lock, policy).join('\n'), /node_modules\/zod/);
  });

  it('reports a linked package', () => {
    const lock = okLock();
    lock.packages['node_modules/zod'] = { resolved: '../zod', link: true };
    assert.match(checkLockfile(lock, policy).join('\n'), /node_modules\/zod/);
  });

  it('reports an entry without integrity', () => {
    const lock = okLock();
    const { integrity: _, ...rest } = entry('zod', '4.6.5');
    lock.packages['node_modules/zod'] = rest;
    const problems = checkLockfile(lock, policy);
    assert.equal(problems.length, 1);
    assert.match(problems[0] ?? '', /node_modules\/zod.*integrity/);
  });

  it('reports an integrity that is not sha512', () => {
    const lock = okLock();
    lock.packages['node_modules/zod'] = entry('zod', '4.6.5', {
      integrity: 'sha1-AAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    });
    assert.match(checkLockfile(lock, policy).join('\n'), /node_modules\/zod.*integrity/);
  });

  it('reports a package with an install script, also when transitive', () => {
    const lock = okLock();
    lock.packages['node_modules/zod/node_modules/helper'] = entry('helper', '1.0.0', {
      hasInstallScript: true,
    });
    const problems = checkLockfile(lock, policy);
    assert.equal(problems.length, 1);
    assert.match(problems[0] ?? '', /node_modules\/zod\/node_modules\/helper.*install script/);
  });

  it('reports a direct package missing from DEPENDENCIES.md', () => {
    const lock = lockOf(
      { dependencies: { zod: '4.6.5', 'left-pad': '1.3.0' } },
      { zod: entry('zod', '4.6.5'), 'left-pad': entry('left-pad', '1.3.0') },
    );
    const problems = checkLockfile(lock, policy);
    assert.equal(problems.length, 1);
    assert.match(problems[0] ?? '', /left-pad.*DEPENDENCIES\.md/);
  });

  it('does not require transitive packages to be listed', () => {
    const lock = okLock();
    lock.packages['node_modules/undici-types'] = entry('undici-types', '7.0.0');
    assert.deepEqual(checkLockfile(lock, policy), []);
  });

  it('reports more runtime packages than the budget allows', () => {
    const names = ['a', 'b', 'c'];
    const lock = lockOf(
      { dependencies: Object.fromEntries(names.map((n) => [n, '1.0.0'])) },
      Object.fromEntries(names.map((n) => [n, entry(n, '1.0.0')])),
    );
    const problems = checkLockfile(lock, { ...policy, admitted: new Set(names) });
    assert.equal(problems.length, 1);
    assert.match(problems[0] ?? '', /runtime.*3.*2/);
  });

  it('reports more packages in total than the budget allows', () => {
    const runtime = ['a', 'b'];
    const dev = ['c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k'];
    const all = [...runtime, ...dev];
    const lock = lockOf(
      {
        dependencies: Object.fromEntries(runtime.map((n) => [n, '1.0.0'])),
        devDependencies: Object.fromEntries(dev.map((n) => [n, '1.0.0'])),
      },
      Object.fromEntries(all.map((n) => [n, entry(n, '1.0.0')])),
    );
    const problems = checkLockfile(lock, { ...policy, admitted: new Set(all) });
    assert.equal(problems.length, 1);
    assert.match(problems[0] ?? '', /total.*11.*10/);
  });

  it('accepts exactly the budget', () => {
    const runtime = ['a', 'b'];
    const dev = ['c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
    const all = [...runtime, ...dev];
    const lock = lockOf(
      {
        dependencies: Object.fromEntries(runtime.map((n) => [n, '1.0.0'])),
        devDependencies: Object.fromEntries(dev.map((n) => [n, '1.0.0'])),
      },
      Object.fromEntries(all.map((n) => [n, entry(n, '1.0.0')])),
    );
    assert.deepEqual(checkLockfile(lock, { ...policy, admitted: new Set(all) }), []);
  });
});

describe('parseLockfile', () => {
  it('reads a lockfile version 3', () => {
    const lock = parseLockfile(JSON.stringify({ lockfileVersion: 3, ...okLock() }));
    assert.deepEqual(lock.packages, okLock().packages);
  });

  it('tolerates a BOM and CRLF', () => {
    const text = `﻿${JSON.stringify({ lockfileVersion: 3, ...okLock() }, null, 2).replaceAll('\n', '\r\n')}`;
    assert.deepEqual(parseLockfile(text).packages, okLock().packages);
  });

  it('rejects an older lockfile version, which would hide its packages', () => {
    assert.throws(
      () => parseLockfile(JSON.stringify({ lockfileVersion: 1, dependencies: {} })),
      /lockfileVersion/,
    );
  });

  it('rejects a lockfile without packages', () => {
    assert.throws(() => parseLockfile(JSON.stringify({ lockfileVersion: 3 })), /packages/);
  });

  it('rejects an entry with a field of the wrong type', () => {
    const lock = okLock();
    const text = JSON.stringify({ lockfileVersion: 3, ...lock }).replace(
      '"integrity":',
      '"hasInstallScript":"no","integrity":',
    );
    assert.throws(() => parseLockfile(text), /hasInstallScript/);
  });
});

describe('readPolicy', () => {
  const md = [
    '## Admitted packages',
    '',
    '| Package | Kind | Purpose |',
    '|---|---|---|',
    '| `zod` | runtime | Schemas |',
    '| `@types/node` | dev | Types |',
    '',
    '## Built-ins used instead of packages',
    '',
    '| Need | Built-in | Instead of |',
    '|---|---|---|',
    '| Tests | `node:test` | vitest |',
    '',
    '## Continuous integration',
    '',
    '- package budget (runtime ≤ 2, total ≤ 10), every package listed in this file.',
  ].join('\n');

  it('reads the admitted packages, the budget and the minimum release age', () => {
    const read = readPolicy(md, 'ignore-scripts=true\nmin-release-age=7\n');
    assert.deepEqual([...read.admitted].sort(), ['@types/node', 'zod']);
    assert.equal(read.runtimeBudget, 2);
    assert.equal(read.totalBudget, 10);
    assert.equal(read.minReleaseAgeDays, 7);
  });

  it('tolerates CRLF', () => {
    const read = readPolicy(md.replaceAll('\n', '\r\n'), 'min-release-age=7\r\n');
    assert.deepEqual([...read.admitted].sort(), ['@types/node', 'zod']);
    assert.equal(read.minReleaseAgeDays, 7);
  });

  it('fails when the budget is missing', () => {
    assert.throws(() => readPolicy('## Admitted packages\n', 'min-release-age=7\n'), /budget/);
  });

  it('fails when the minimum release age is missing', () => {
    assert.throws(() => readPolicy(md, 'ignore-scripts=true\n'), /min-release-age/);
  });

  it('reads the policy from the repository files', async () => {
    const { readFileSync } = await import('node:fs');
    const read = readPolicy(
      readFileSync(join(root, 'DEPENDENCIES.md'), 'utf8'),
      readFileSync(join(root, '.npmrc'), 'utf8'),
    );
    assert.ok(read.admitted.has('zod'));
    assert.ok(read.admitted.has('typescript'));
    assert.ok(!read.admitted.has('better-sqlite3'));
    assert.equal(read.minReleaseAgeDays, 7);
  });
});

describe('checkPublishDates', () => {
  const now = new Date('2026-10-15T12:00:00Z');
  const daysAgo = (days: number): string => new Date(now.getTime() - days * DAY).toISOString();

  const registryOf = (times: Record<string, Record<string, string>>) => {
    const asked: string[] = [];
    const fake = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      asked.push(url);
      const name = decodeURIComponent(url.slice(registry.length + 1));
      const time = times[name];
      return time === undefined
        ? new Response('not found', { status: 404 })
        : Response.json({ name, time });
    };
    return { fetch: fake as typeof fetch, asked };
  };

  it('passes versions older than the minimum release age', async () => {
    const { fetch } = registryOf({
      zod: { '4.6.5': daysAgo(8) },
      typescript: { '7.0.2': daysAgo(30) },
    });
    assert.deepEqual(await checkPublishDates(okLock(), { fetch, now, minReleaseAgeDays: 7 }), []);
  });

  it('reports a version younger than the minimum release age', async () => {
    const { fetch } = registryOf({
      zod: { '4.6.5': daysAgo(1) },
      typescript: { '7.0.2': daysAgo(30) },
    });
    const problems = await checkPublishDates(okLock(), { fetch, now, minReleaseAgeDays: 7 });
    assert.equal(problems.length, 1);
    assert.match(problems[0] ?? '', /zod@4\.6\.5.*7 days/);
  });

  it('reports a version published just inside the minimum release age', async () => {
    const { fetch } = registryOf({
      zod: { '4.6.5': new Date(now.getTime() - 7 * DAY + 60_000).toISOString() },
      typescript: { '7.0.2': daysAgo(30) },
    });
    const problems = await checkPublishDates(okLock(), { fetch, now, minReleaseAgeDays: 7 });
    assert.equal(problems.length, 1);
  });

  it('reports a version without a publish date', async () => {
    const { fetch } = registryOf({ zod: {}, typescript: { '7.0.2': daysAgo(30) } });
    const problems = await checkPublishDates(okLock(), { fetch, now, minReleaseAgeDays: 7 });
    assert.equal(problems.length, 1);
    assert.match(problems[0] ?? '', /zod@4\.6\.5/);
  });

  it('reports a package the registry does not know', async () => {
    const { fetch } = registryOf({ typescript: { '7.0.2': daysAgo(30) } });
    const problems = await checkPublishDates(okLock(), { fetch, now, minReleaseAgeDays: 7 });
    assert.equal(problems.length, 1);
    assert.match(problems[0] ?? '', /zod.*404/);
  });

  it('reports a network failure instead of passing', async () => {
    const failing = (async () => {
      throw new Error('offline');
    }) as typeof fetch;
    const problems = await checkPublishDates(okLock(), {
      fetch: failing,
      now,
      minReleaseAgeDays: 7,
    });
    assert.equal(problems.length, 2);
    assert.match(problems.join('\n'), /offline/);
  });

  it('asks the registry once per package name, with scoped names encoded', async () => {
    const lock = lockOf(
      { devDependencies: { '@types/node': '24.19.1' } },
      {
        '@types/node': entry('@types/node', '24.19.1'),
        'a/node_modules/@types/node': entry('@types/node', '24.0.0'),
      },
    );
    const { fetch, asked } = registryOf({
      '@types/node': { '24.19.1': daysAgo(30), '24.0.0': daysAgo(90) },
    });
    assert.deepEqual(await checkPublishDates(lock, { fetch, now, minReleaseAgeDays: 7 }), []);
    assert.deepEqual(asked, [`${registry}/@types%2Fnode`]);
  });

  it('uses the real name of an aliased package', async () => {
    const lock = lockOf(
      { dependencies: { z: 'npm:zod@4.6.5' } },
      { z: entry('zod', '4.6.5', { name: 'zod' }) },
    );
    const { fetch, asked } = registryOf({ zod: { '4.6.5': daysAgo(30) } });
    assert.deepEqual(await checkPublishDates(lock, { fetch, now, minReleaseAgeDays: 7 }), []);
    assert.deepEqual(asked, [`${registry}/zod`]);
  });
});

describe('check-deps CLI', () => {
  let dir: TempDir;
  const md =
    '## Admitted packages\n\n| Package |\n|---|\n| `zod` |\n| `typescript` |\n\n' +
    'Package budget (runtime ≤ 2, total ≤ 10).\n';

  const write = (lock: Lockfile): void => {
    writeFileSync(
      join(dir.path, 'package-lock.json'),
      JSON.stringify({ lockfileVersion: 3, ...lock }),
    );
  };

  const run = (...args: string[]) =>
    spawnSync(process.execPath, [script, ...args], { cwd: dir.path, encoding: 'utf8' });

  before(() => {
    dir = makeTempDir('check-deps');
    writeFileSync(join(dir.path, 'DEPENDENCIES.md'), md);
    writeFileSync(join(dir.path, '.npmrc'), 'min-release-age=7\n');
  });
  after(() => dir.remove());

  it('exits 0 offline for a lockfile that passes', () => {
    write(okLock());
    const result = run('--offline');
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });

  it('exits 1 and prints one line per problem', () => {
    const lock = okLock();
    lock.packages['node_modules/zod'] = entry('zod', '4.6.5', { hasInstallScript: true });
    write(lock);
    const result = run('--offline');
    assert.equal(result.status, 1);
    assert.match(result.stdout, /node_modules\/zod.*install script/);
  });

  it('exits 2 on an unknown argument', () => {
    write(okLock());
    assert.equal(run('--online').status, 2);
  });
});
