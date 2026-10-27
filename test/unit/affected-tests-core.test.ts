// Which test files a change reaches (ADR 0241), from file lists and file texts.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { affectedTests, isTestFile } from '../../scripts/affected-tests/core.ts';

// A small tree: a CLI file imported by a command module, which one test imports; a schema
// module another test imports; a test that imports nothing of the tree.
const tree = (extra: Record<string, string> = {}): Map<string, string> =>
  new Map(
    Object.entries({
      'src/cli/format.ts': 'export const format = (s: string) => s;\n',
      'src/cli/status.ts': "import { format } from './format.ts';\nexport const status = format;\n",
      'src/schemas/order.ts': "import { z } from 'zod';\nexport const order = z.string();\n",
      'test/unit/status.test.ts':
        "import { it } from 'node:test';\nimport { status } from '../../src/cli/status.ts';\n",
      'test/unit/order.test.ts': "import { order } from '../../src/schemas/order.ts';\n",
      'test/property/fold.test.ts': "import assert from 'node:assert/strict';\n",
      ...extra,
    }),
  );

const some = (...files: string[]) => ({ kind: 'some', files });

describe('isTestFile', () => {
  it('is a .test.ts file under test/unit, test/property or test/chaos, at any depth', () => {
    assert.equal(isTestFile('test/unit/check.test.ts'), true);
    assert.equal(isTestFile('test/unit/engine/fold.test.ts'), true);
    assert.equal(isTestFile('test/property/fold.test.ts'), true);
    assert.equal(isTestFile('test/chaos/shrink.test.ts'), true);
  });

  it('is not an integration test, a helper or a file that is not a test', () => {
    assert.equal(isTestFile('test/integration/demo.test.ts'), false);
    assert.equal(isTestFile('test/helpers/load.ts'), false);
    assert.equal(isTestFile('test/unit/fixture.ts'), false);
    assert.equal(isTestFile('src/unit/x.test.ts'), false);
  });
});

describe('affectedTests', () => {
  it('follows an import chain two files deep to the test at its end', () => {
    assert.deepEqual(
      affectedTests(['src/cli/format.ts'], tree()),
      some('test/unit/status.test.ts'),
    );
  });

  it('leaves out a test file that imports nothing changed', () => {
    const { files } = affectedTests(['src/schemas/order.ts'], tree()) as { files: string[] };
    assert.deepEqual(files, ['test/unit/order.test.ts']);
  });

  it('reaches a changed test file itself', () => {
    assert.deepEqual(
      affectedTests(['test/property/fold.test.ts'], tree()),
      some('test/property/fold.test.ts'),
    );
  });

  it('lists each test file once, sorted, when several changes reach it', () => {
    assert.deepEqual(
      affectedTests(
        [
          'src/schemas/order.ts',
          'src/cli/status.ts',
          'src/cli/format.ts',
          'test/unit/order.test.ts',
        ],
        tree(),
      ),
      some('test/unit/order.test.ts', 'test/unit/status.test.ts'),
    );
  });

  for (const path of [
    'package.json',
    'package-lock.json',
    'tsconfig.json',
    'scripts/test-cpu-time.ts',
    'test/helpers/load.ts',
  ]) {
    it(`reaches every test file when ${path} changed`, () => {
      const affected = affectedTests(['src/cli/format.ts', path], tree());
      assert.equal(affected.kind, 'all');
      assert.match((affected as { why: string }).why, new RegExp(path.replace('.', '\\.')));
    });
  }

  for (const path of [
    'test/fixtures/brew-review/planted-demo/a.json',
    'defaults/recipes/default.jsonc',
    'schemas/order.schema.json',
    'biome.json',
    'plugin/skills/status/SKILL.md',
  ]) {
    it(`reaches every test file when a file that is not TypeScript changed: ${path}`, () => {
      const affected = affectedTests([path], tree());
      assert.equal(affected.kind, 'all');
      assert.match((affected as { why: string }).why, /read by path/);
    });
  }

  it('reaches no test file for a change only to docs', () => {
    assert.deepEqual(
      affectedTests(['docs/adr/0241-x.md', 'docs/design/testing/unit.md', 'README.md'], tree()),
      some(),
    );
  });

  it('reaches no test file for a TypeScript file no test imports', () => {
    assert.deepEqual(affectedTests(['test/integration/demo.test.ts'], tree()), some());
  });

  it('reaches the files that still import a deleted file', () => {
    const texts = tree();
    texts.delete('src/cli/format.ts');
    assert.deepEqual(affectedTests(['src/cli/format.ts'], texts), some('test/unit/status.test.ts'));
  });

  it('reaches the importers of both paths of a renamed file', () => {
    const texts = tree({
      'src/cli/layout.ts': 'export const format = (s: string) => s;\n',
      'test/unit/layout.test.ts': "import { format } from '../../src/cli/layout.ts';\n",
    });
    texts.delete('src/cli/format.ts');
    assert.deepEqual(
      affectedTests(['src/cli/format.ts', 'src/cli/layout.ts'], texts),
      some('test/unit/layout.test.ts', 'test/unit/status.test.ts'),
    );
  });

  it('follows a dynamic import of a literal path', () => {
    const texts = tree({
      'src/cli/main.ts': "const run = async () => (await import('./status.ts')).status;\n",
      'test/unit/main.test.ts': "await import(\n  '../../src/cli/main.ts'\n);\n",
    });
    assert.deepEqual(
      affectedTests(['src/cli/format.ts'], texts),
      some('test/unit/main.test.ts', 'test/unit/status.test.ts'),
    );
  });

  it('follows multi-line imports, type imports, re-exports and imports for side effects', () => {
    const texts = tree({
      'src/cli/index.ts': "export { status } from './status.ts';\nexport * from './format.ts';\n",
      'src/cli/types.ts': "import type {\n  Order,\n} from '../schemas/order.ts';\n",
      'src/cli/setup.ts': "import './format.ts';\n",
      'test/unit/index.test.ts': "import {\n  status,\n} from '../../src/cli/index.ts';\n",
      'test/unit/types.test.ts': 'import type { X } from "../../src/cli/types.ts";\n',
      'test/unit/setup.test.ts': "import '../../src/cli/setup.ts';\n",
    });
    assert.deepEqual(
      affectedTests(['src/cli/format.ts', 'src/schemas/order.ts'], texts),
      some(
        'test/unit/index.test.ts',
        'test/unit/order.test.ts',
        'test/unit/setup.test.ts',
        'test/unit/status.test.ts',
        'test/unit/types.test.ts',
      ),
    );
  });

  it('does not follow a package import to a file of the same name', () => {
    const texts = tree({ 'zod.ts': '', 'src/zod.ts': '' });
    assert.deepEqual(affectedTests(['zod.ts', 'src/zod.ts'], texts), some());
  });

  it('survives an import cycle', () => {
    const texts = tree({
      'src/a.ts': "import './b.ts';\n",
      'src/b.ts': "import './a.ts';\n",
      'test/unit/a.test.ts': "import '../../src/a.ts';\n",
    });
    assert.deepEqual(affectedTests(['src/b.ts'], texts), some('test/unit/a.test.ts'));
  });
});
