import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { checkTestLayers, NO_PROCESS_FOLDERS } from '../../scripts/check-test-layers.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';

// The planted-defect sample of /brew-review (its README). The patches are data, never applied
// here: this reads the lines they add.
const sample = join(import.meta.dirname, '..', 'fixtures', 'brew-review', 'planted-demo');

// Adds the lines a patch adds to `added`, by the path of the file it adds them to.
const addLines = (patch: string, added: Map<string, string[]>): void => {
  let file: string | undefined;
  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) file = undefined;
    else if (line.startsWith('+++ b/')) file = line.slice('+++ b/'.length);
    else if (file !== undefined && line.startsWith('+')) {
      added.set(file, [...(added.get(file) ?? []), line.slice(1)]);
    }
  }
};

describe('the planted-defect sample', () => {
  let tree: TempDir;
  let testFiles: string[];

  // Every line the patches add to a file under test/, written to that path in a scratch folder,
  // so the layer guard of npm run check reads them as it would read the sample once applied.
  before(() => {
    tree = makeTempDir('planted-demo');
    const files = new Map<string, string[]>();
    for (const name of readdirSync(sample)
      .filter((entry) => entry.endsWith('.patch'))
      .sort()) {
      addLines(readFileSync(join(sample, name), 'utf8'), files);
    }
    testFiles = [...files.keys()].filter((file) => file.startsWith('test/'));
    for (const file of testFiles) {
      const path = join(tree.path, ...file.split('/'));
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${files.get(file)?.join('\n')}\n`);
    }
  });

  after(() => tree.remove());

  // A process start in a unit test would fail the sample at its head without any mutant, so a
  // mutation check on it would compare a broken fixture, not the review (#43). This sees direct
  // imports only, like the layer guard; the planted process start is in the code (0006).
  it('adds no test that starts a process to a layer npm test runs (ADR 0021)', () => {
    assert.ok(
      testFiles.some((file) =>
        NO_PROCESS_FOLDERS.some((folder) => file.startsWith(`test/${folder}/`)),
      ),
      `no test file found in the patches: ${testFiles.join(', ')}`,
    );
    assert.deepEqual(checkTestLayers(join(tree.path, 'test'), new Map()), []);
  });
});
