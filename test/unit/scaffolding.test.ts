import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const root = join(import.meta.dirname, '..', '..');

interface DevEngine {
  name: string;
  version: string;
  onFail: string;
}

interface PackageJson {
  type?: string;
  license?: string;
  engines?: Record<string, string>;
  devEngines?: { runtime?: DevEngine; packageManager?: DevEngine };
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const readPackageJson = (): PackageJson =>
  JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as PackageJson;

describe('package.json', () => {
  const pkg = readPackageJson();

  it('is an ES module package requiring Node 24.15 or later', () => {
    assert.equal(pkg.type, 'module');
    assert.equal(pkg.engines?.node, '>=24.15');
  });

  it('is licensed AGPL-3.0-only', () => {
    assert.equal(pkg.license, 'AGPL-3.0-only');
  });

  it('fails development installs on a Node or npm too old for the .npmrc hardening', () => {
    assert.deepEqual(pkg.devEngines?.runtime, {
      name: 'node',
      version: '>=24.15',
      onFail: 'error',
    });
    assert.deepEqual(pkg.devEngines?.packageManager, {
      name: 'npm',
      version: '>=11.19.0',
      onFail: 'error',
    });
  });

  it('has no pre* or post* scripts (lifecycle scripts are disabled by .npmrc)', () => {
    const lifecycle = Object.keys(pkg.scripts ?? {}).filter(
      (name) => name.startsWith('pre') || name.startsWith('post'),
    );
    assert.deepEqual(lifecycle, []);
  });

  it('pins every dependency to an exact version', () => {
    const all = { ...pkg.dependencies, ...pkg.devDependencies };
    const ranged = Object.entries(all).filter(([, version]) => !/^\d+\.\d+\.\d+$/.test(version));
    assert.deepEqual(ranged, []);
  });

  // npm run check runs it offline: see scripts/check.ts and test/unit/check.test.ts.
  it('runs the dependency guard in full as check:deps', () => {
    assert.equal(pkg.scripts?.['check:deps'], 'node scripts/check-deps.ts');
  });
});
