import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { coveringTests, mutantTests } from '../../scripts/mutant-tests.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';

describe('the test files for mutants of a tree', () => {
  let dir: TempDir;

  const write = (file: string, text: string): void => {
    mkdirSync(dirname(join(dir.path, file)), { recursive: true });
    writeFileSync(join(dir.path, file), text);
  };

  beforeEach(() => {
    dir = makeTempDir('mutant-tests');
    write('src/engine/fold.ts', '');
    write('scripts/check.ts', "import '../src/engine/fold.ts';\n");
    write('test/unit/fold.test.ts', "import '../../src/engine/fold.ts';\n");
    write('test/unit/check.test.ts', "import '../../scripts/check.ts';\n");
    write('test/unit/other.test.ts', '');
    write('test/integration/fold.test.ts', "import '../../src/engine/fold.ts';\n");
  });
  afterEach(() => dir.remove());

  it('prints the test files that import the given files, sorted', async () => {
    assert.deepEqual(await mutantTests(dir.path, ['src/engine/fold.ts']), {
      ok: true,
      lines: ['test/unit/check.test.ts', 'test/unit/fold.test.ts'],
    });
  });

  it('prints nothing when no test file imports them', async () => {
    write('src/lonely.ts', '');
    assert.deepEqual(await mutantTests(dir.path, ['src/lonely.ts']), { ok: true, lines: [] });
  });

  it('fails when the tree cannot be read', async () => {
    const result = await mutantTests(join(dir.path, 'missing'), ['src/engine/fold.ts']);
    assert.equal(result.ok, false);
    assert.match(result.lines.join('\n'), /cannot read/);
  });

  it('prints the test files of every layer that reach the given files, for the coverage delta', async () => {
    write('test/integration/check.test.ts', "const script = join(root, 'scripts', 'check.ts');\n");
    assert.deepEqual(await coveringTests(dir.path, ['src/engine/fold.ts']), {
      ok: true,
      lines: ['test/integration/fold.test.ts', 'test/unit/check.test.ts', 'test/unit/fold.test.ts'],
    });
    assert.deepEqual(await coveringTests(dir.path, ['scripts/check.ts']), {
      ok: true,
      lines: ['test/integration/check.test.ts', 'test/unit/check.test.ts'],
    });
  });
});
