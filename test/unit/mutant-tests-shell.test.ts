import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { coveringTests, main, mutantTests } from '../../scripts/mutant-tests.ts';
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

  it('runs the mutant selection by default and the coverage selection with --coverage', async () => {
    assert.deepEqual(await main([dir.path, 'src/engine/fold.ts']), {
      exitCode: 0,
      stdout: ['test/unit/check.test.ts', 'test/unit/fold.test.ts'],
      stderr: [],
    });
    assert.deepEqual(await main(['--coverage', dir.path, 'src/engine/fold.ts']), {
      exitCode: 0,
      stdout: [
        'test/integration/fold.test.ts',
        'test/unit/check.test.ts',
        'test/unit/fold.test.ts',
      ],
      stderr: [],
    });
  });

  it('says how to use it without a tree or a file, and fails on a tree it cannot read', async () => {
    for (const argv of [[], [dir.path], ['--coverage', dir.path]]) {
      const result = await main(argv);
      assert.equal(result.exitCode, 2, argv.join(' '));
      assert.match(result.stderr.join('\n'), /^usage: /);
    }
    const missing = await main([join(dir.path, 'missing'), 'src/engine/fold.ts']);
    assert.equal(missing.exitCode, 1);
    assert.match(missing.stderr.join('\n'), /^mutant-tests: cannot read /);
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
