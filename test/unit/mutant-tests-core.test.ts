import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { importsOf, testsFor } from '../../scripts/mutant-tests/core.ts';

describe('importsOf', () => {
  it('finds static, type, side-effect and dynamic imports and re-exports', () => {
    const source = [
      "import { a } from './a.ts';",
      "import type { B } from '../b.ts';",
      "import './c.ts';",
      'export { d } from "./d.ts";',
      "export * from './e.ts';",
      "const { f } = await import('./f.ts');",
      'import {',
      '  g,',
      "} from './g.ts';",
    ].join('\n');
    assert.deepEqual(importsOf(source), [
      './a.ts',
      '../b.ts',
      './c.ts',
      './d.ts',
      './e.ts',
      './f.ts',
      './g.ts',
    ]);
  });

  it('leaves out packages and built-ins', () => {
    const source = "import { z } from 'zod';\nimport { join } from 'node:path';\n";
    assert.deepEqual(importsOf(source), []);
  });
});

const sources = (files: Record<string, string>): ReadonlyMap<string, string> =>
  new Map(Object.entries(files));

const imports = (...specifiers: string[]): string =>
  specifiers.map((specifier) => `import '${specifier}';\n`).join('');

describe('testsFor', () => {
  it('picks a test file that imports the target', () => {
    const tree = sources({
      'src/engine/fold.ts': '',
      'test/unit/fold.test.ts': imports('../../src/engine/fold.ts'),
      'test/unit/other.test.ts': imports('../../src/engine/decide.ts'),
    });
    assert.deepEqual(testsFor(tree, ['src/engine/fold.ts']), ['test/unit/fold.test.ts']);
  });

  it('picks one that imports it through a helper or another module', () => {
    const tree = sources({
      'src/engine/fold.ts': '',
      'src/engine/decide.ts': imports('./fold.ts'),
      'test/helpers/simulation.ts': imports('../../src/engine/fold.ts'),
      'test/property/i1.test.ts': imports('../helpers/simulation.ts'),
      'test/chaos/kills.test.ts': imports('../../src/engine/decide.ts'),
    });
    assert.deepEqual(testsFor(tree, ['src/engine/fold.ts']), [
      'test/chaos/kills.test.ts',
      'test/property/i1.test.ts',
    ]);
  });

  it('leaves out a test file two modules away', () => {
    const tree = sources({
      'src/engine/fold.ts': '',
      'src/engine/decide.ts': imports('./fold.ts'),
      'src/engine/driver.ts': imports('./decide.ts'),
      'test/unit/driver.test.ts': imports('../../src/engine/driver.ts'),
    });
    assert.deepEqual(testsFor(tree, ['src/engine/fold.ts']), []);
  });

  it('leaves out integration tests, helpers and files that are not tests', () => {
    const tree = sources({
      'scripts/check.ts': '',
      'test/integration/check.test.ts': imports('../../scripts/check.ts'),
      'test/helpers/check.ts': imports('../../scripts/check.ts'),
      'test/unit/check.ts': imports('../../scripts/check.ts'),
      'test/fixtures/check.test.ts': imports('../../scripts/check.ts'),
    });
    assert.deepEqual(testsFor(tree, ['scripts/check.ts']), []);
  });

  it('lists each test file once for several targets', () => {
    const tree = sources({
      'src/a.ts': '',
      'src/b.ts': '',
      'test/unit/ab.test.ts': imports('../../src/a.ts', '../../src/b.ts'),
      'test/unit/b.test.ts': imports('../../src/b.ts'),
    });
    assert.deepEqual(testsFor(tree, ['src/b.ts', 'src/a.ts']), [
      'test/unit/ab.test.ts',
      'test/unit/b.test.ts',
    ]);
  });
});
