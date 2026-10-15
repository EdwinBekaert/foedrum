import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, it } from 'node:test';

const root = join(import.meta.dirname, '..', '..');

// Each runtime dependency may be imported by its wrapper module only (CLAUDE.md, Dependencies).
const wrappers: Record<string, string> = {
  zod: 'src/schemas/zod.ts',
};

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => relative(root, join(entry.parentPath, entry.name)).split(sep).join('/'));

const importsOf = (file: string): string[] =>
  [
    ...readFileSync(join(root, file), 'utf8').matchAll(
      /\b(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g,
    ),
  ].map((match) => match[1] as string);

const packageName = (specifier: string): string =>
  specifier
    .split('/')
    .slice(0, specifier.startsWith('@') ? 2 : 1)
    .join('/');

describe('dependency wrappers', () => {
  const files = [...sourceFiles(join(root, 'src')), ...sourceFiles(join(root, 'scripts'))];

  for (const [dependency, wrapper] of Object.entries(wrappers)) {
    it(`only ${wrapper} imports ${dependency}`, () => {
      const importers = files.filter((file) =>
        importsOf(file).some((specifier) => packageName(specifier) === dependency),
      );
      assert.deepEqual(importers, [wrapper]);
    });
  }

  it('every runtime dependency has a wrapper', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    assert.deepEqual(Object.keys(pkg.dependencies ?? {}).sort(), Object.keys(wrappers).sort());
  });
});
