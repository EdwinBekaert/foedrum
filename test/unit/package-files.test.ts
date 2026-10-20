// The package ships the program, never the tests' fakes or the development scripts that use them,
// such as npm run demo's (ADR 0097).

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { describe, it } from 'node:test';

const root = join(import.meta.dirname, '..', '..');

const filesUnder = (folder: string): string[] =>
  readdirSync(folder, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => join(entry.parentPath, entry.name));

// Static imports and re-exports, `import()` and `import type`, by their relative specifier.
const SPECIFIER = /(?:\bfrom|\bimport)\s*\(?\s*(['"])(\.{1,2}\/[^'"]+)\1/g;

/** The relative imports in `source`, the text of `file`, that reach into test/ or scripts/. */
const importsOutside = (file: string, source: string): string[] =>
  [...source.matchAll(SPECIFIER)].flatMap(([, , specifier = '']) => {
    const target = relative(root, resolve(dirname(file), specifier));
    return target.startsWith(`test${sep}`) || target.startsWith(`scripts${sep}`) ? [specifier] : [];
  });

describe('the shipped package', () => {
  it('lists the folders it ships, none of them test/ or scripts/', () => {
    const { files } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      files?: string[];
    };
    assert.deepStrictEqual(files, ['src/', 'defaults/', 'schemas/']);
  });

  it('has no module under src/ that imports from test/ or scripts/', () => {
    const outside = filesUnder(join(root, 'src')).flatMap((file) =>
      importsOutside(file, readFileSync(file, 'utf8')).map(
        (specifier) => `${relative(root, file)} imports ${specifier}`,
      ),
    );
    assert.deepStrictEqual(outside, []);
  });

  it('flags an import of test/ or scripts/ from a module under src/, and no other', () => {
    const file = join(root, 'src', 'cli', 'serve.ts');
    const source = [
      "import { fakeGitHubApi } from '../../test/helpers/fake-github-api.ts';",
      "export type { DemoRun } from '../../scripts/demo/core.ts';",
      "const later = await import('../../scripts/demo.ts');",
      "import { runServe } from './serve-shell.ts';",
      "import type { Event } from '../schemas/events.ts';",
      "import { a } from '../test/x.ts';",
    ].join('\n');
    assert.deepStrictEqual(importsOutside(file, source), [
      '../../test/helpers/fake-github-api.ts',
      '../../scripts/demo/core.ts',
      '../../scripts/demo.ts',
    ]);
  });

  it('finds an import of the tests from src/ when there is one', () => {
    const source = "import { fakeGitHubApi } from '../../test/helpers/fake-github-api.ts';";
    const [match] = source.matchAll(SPECIFIER);
    assert.equal(match?.[2], '../../test/helpers/fake-github-api.ts');
  });
});
