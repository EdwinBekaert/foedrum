// scripts/deps-sync.ts started by node with a stub npm (ADR 0021). Its decisions are unit tests
// in test/unit/deps-sync-core.test.ts and deps-sync-shell.test.ts.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { outOfDate } from '../../scripts/deps-sync.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';

const root = join(import.meta.dirname, '..', '..');
const script = join(root, 'scripts', 'deps-sync.ts');
const npmStub = join(root, 'test', 'fixtures', 'npm-cli-stub.ts');

const zod = { version: '4.6.5', integrity: 'sha512-z' };

// The environment without npm's own variables, so the test controls which npm the script sees.
const env = (npmExecpath: string): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_/i.test(key))),
  npm_execpath: npmExecpath,
});

const runScript = (cwd: string) =>
  spawnSync(process.execPath, [script], { cwd, env: env(npmStub), encoding: 'utf8' });

// The record a real npm ci wrote (npm 11.19.0 on Windows, for this repository's lock file of
// 2026-10-18), captured in test/fixtures/deps-sync, so this checks the core against what npm writes,
// with the optional packages of other platforms skipped, whatever state this checkout's own
// node_modules is in (#212).
describe('outOfDate on a package tree npm ci installed', () => {
  let project: TempDir;
  beforeEach(() => {
    project = makeTempDir('deps-sync-installed');
  });
  afterEach(() => project.remove());

  it('finds node_modules up to date after npm ci', async () => {
    const captured = join(root, 'test', 'fixtures', 'deps-sync');
    writeFileSync(join(project.path, 'package.json'), '{"private":true}\n');
    copyFileSync(join(captured, 'package-lock.json'), join(project.path, 'package-lock.json'));
    mkdirSync(join(project.path, 'node_modules'));
    copyFileSync(
      join(captured, 'installed.package-lock.json'),
      join(project.path, 'node_modules', '.package-lock.json'),
    );
    assert.equal(await outOfDate(project.path), undefined);
  });
});

describe('scripts/deps-sync.ts with a stub npm', () => {
  // Each test gets its own project with a src folder and no node_modules, so their order does
  // not matter.
  let project: TempDir;
  beforeEach(() => {
    project = makeTempDir('deps-sync');
    writeFileSync(join(project.path, 'package.json'), '{"private":true}\n');
    const packages = { '': {}, 'node_modules/zod': zod };
    writeFileSync(join(project.path, 'package-lock.json'), JSON.stringify({ packages }));
    mkdirSync(join(project.path, 'src'));
  });
  afterEach(() => project.remove());

  it('runs npm ci in the package root when node_modules is stale, and never fails', () => {
    const { status, stdout, stderr } = runScript(join(project.path, 'src'));
    assert.equal(status, 0, stderr);
    // The stub npm echoes its arguments and exits 3.
    assert.match(stdout, /^deps:sync: node_modules is out of date .* npm ci failed \(exit 3\)/);
    assert.match(stdout, /stub npm: ci\n/);
    assert.ok(stdout.includes(`stub npm cwd: ${project.path}\n`), stdout);
  });

  it('prints nothing when node_modules matches', () => {
    mkdirSync(join(project.path, 'node_modules'), { recursive: true });
    const installed = { packages: { 'node_modules/zod': zod } };
    writeFileSync(
      join(project.path, 'node_modules', '.package-lock.json'),
      JSON.stringify(installed),
    );
    const { status, stdout, stderr } = runScript(project.path);
    assert.equal(status, 0, stderr);
    assert.equal(stdout, '');
  });
});
