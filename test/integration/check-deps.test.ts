// scripts/check-deps.ts started by node (ADR 0021): the entry point reads the files from its
// working directory and turns run's result into the exit code. Argument handling, exit codes
// and the registry are unit tests of run in test/unit/check-deps.test.ts.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';

const script = join(import.meta.dirname, '..', '..', 'scripts', 'check-deps.ts');

const integrity = `sha512-${'A'.repeat(86)}==`;
const lockfile = {
  lockfileVersion: 3,
  packages: {
    '': { name: 'demo', dependencies: { zod: '4.6.5' } },
    'node_modules/zod': {
      version: '4.6.5',
      resolved: 'https://registry.npmjs.org/zod/-/zod-4.6.5.tgz',
      integrity,
    },
  },
};

describe('check-deps command', () => {
  let dir: TempDir;
  before(() => {
    dir = makeTempDir('check-deps');
    writeFileSync(
      join(dir.path, 'DEPENDENCIES.md'),
      '## Admitted packages\n\n| Package |\n|---|\n| `zod` |\n\nPackage budget (runtime ≤ 2, total ≤ 10).\n',
    );
    writeFileSync(join(dir.path, '.npmrc'), 'min-release-age=7\n');
  });
  after(() => dir.remove());

  const run = (...args: string[]) =>
    spawnSync(process.execPath, [script, ...args], { cwd: dir.path, encoding: 'utf8' });

  it('exits 0 offline for a lockfile in its working directory that passes', () => {
    writeFileSync(join(dir.path, 'package-lock.json'), JSON.stringify(lockfile));
    const result = run('--offline');
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });

  it('exits 1 and prints the problem on stdout', () => {
    const scripted = structuredClone(lockfile);
    Object.assign(scripted.packages['node_modules/zod'], { hasInstallScript: true });
    writeFileSync(join(dir.path, 'package-lock.json'), JSON.stringify(scripted));
    const result = run('--offline');
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /node_modules\/zod.*install script/);
  });
});
