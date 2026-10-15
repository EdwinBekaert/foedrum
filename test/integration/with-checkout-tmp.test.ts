// scripts/with-checkout-tmp.ts started by node: the program it runs sees a folder under
// .foedrum/tmp/tests/ as os.tmpdir() (TEMP and TMP on Windows, TMPDIR elsewhere), the folder is
// gone afterwards, and the program's exit code comes through. The decisions are unit-tested
// in test/unit/with-checkout-tmp.test.ts.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const root = join(import.meta.dirname, '..', '..');
const script = join(root, 'scripts', 'with-checkout-tmp.ts');

const wrap = (code: string) =>
  spawnSync(process.execPath, [script, '-e', code], { cwd: root, encoding: 'utf8' });

describe('with-checkout-tmp command', () => {
  it('runs node with os.tmpdir() in .foedrum/tmp/tests/ and removes that folder', () => {
    const result = wrap(
      "require('node:fs').writeFileSync(require('node:path').join(require('node:os').tmpdir(), 'f'), 'x'); console.log(require('node:os').tmpdir())",
    );
    assert.equal(result.status, 0, result.stderr);
    const dir = result.stdout.trim();
    assert.ok(dir.startsWith(join(root, '.foedrum', 'tmp', 'tests', 'tmpdir-')), dir);
    assert.equal(existsSync(dir), false, `${dir} was left behind`);
  });

  it("exits with the program's exit code", () => {
    assert.equal(wrap('process.exitCode = 5').status, 5);
  });
});
