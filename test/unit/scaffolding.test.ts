import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const root = join(import.meta.dirname, '..', '..');

interface PackageJson {
  type?: string;
  engines?: Record<string, string>;
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
});
