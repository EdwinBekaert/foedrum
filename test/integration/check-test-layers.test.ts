// scripts/check-test-layers.ts started by node: it scans test/, passes silently for a test/ with no
// probe, and fails naming a file under test/unit/ that imports child_process, or the file and line
// of an integration test that can start the real gh (ADR 0086). That it passes as this repository
// stands, `npm run check` shows on every run. The failing runs use a copy of the script, which
// scans the test/ beside it, in a folder of the test's own: a probe in the tracked tree would fail
// an `npm run check` running beside this test. The matching itself is unit-tested against fixtures
// in test/unit/check-test-layers.test.ts.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';

const root = join(import.meta.dirname, '..', '..');
const script = join(root, 'scripts', 'check-test-layers.ts');

const runGuard = (file = script) => spawnSync(process.execPath, [file], { encoding: 'utf8' });

describe('check-test-layers command', () => {
  let dir: TempDir;
  let copy: string;
  /** Runs the copy with `text` as the file `path` of its test/. */
  const withProbe = (path: string, text: string) => {
    const probe = join(dir.path, 'test', path);
    mkdirSync(dirname(probe), { recursive: true });
    writeFileSync(probe, text);
    try {
      return runGuard(copy);
    } finally {
      rmSync(probe);
    }
  };
  // Beside the copy, the one test the script excepts by name, so that exception is not stale and a
  // test/ with no probe passes: the failures below are the probes'.
  before(() => {
    dir = makeTempDir('check-test-layers');
    copy = join(dir.path, 'scripts', 'check-test-layers.ts');
    cpSync(script, copy);
    const excepted = join('test', 'integration', 'serve.test.ts');
    cpSync(join(root, excepted), join(dir.path, excepted));
    const clean = runGuard(copy);
    assert.deepEqual([clean.status, clean.stdout], [0, ''], clean.stderr);
  });
  after(() => dir.remove());

  it('exits 1 naming a file under test/unit/ that imports child_process', () => {
    const result = withProbe(
      'unit/guard-probe.ts',
      "export { spawn } from 'node:child_process';\n",
    );
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /^test\/unit\/guard-probe\.ts imports child_process/m);
  });

  it('exits 1 naming the file and line of an integration test that can start the real gh', () => {
    const result = withProbe(
      'integration/guard-probe.ts',
      '// doctor without a runner\nawait doctorFromCheckout(process.cwd());\n',
    );
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /^test\/integration\/guard-probe\.ts:2 [^\n]*doctorFromCheckout/m);
  });
});
