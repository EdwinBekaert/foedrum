// scripts/check-test-layers.ts started by node on this repository: it scans test/unit/, passes
// as the repository stands, and fails naming a file there that imports child_process. The
// matching itself is unit-tested against fixtures in test/unit/check-test-layers.test.ts.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const root = join(import.meta.dirname, '..', '..');
const script = join(root, 'scripts', 'check-test-layers.ts');

const runGuard = () => spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });

describe('check-test-layers command', () => {
  it('exits 0 silently for test/unit/ as it stands', () => {
    const result = runGuard();
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stdout, '');
  });

  it('exits 1 naming a file under test/unit/ that imports child_process', () => {
    // Not a *.test.ts file, so npm test never runs it if it is ever left behind.
    const probe = join(root, 'test', 'unit', 'guard-probe.ts');
    writeFileSync(probe, "export { spawn } from 'node:child_process';\n");
    try {
      const result = runGuard();
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stdout, /^test\/unit\/guard-probe\.ts imports child_process/m);
    } finally {
      rmSync(probe, { force: true });
    }
  });
});
