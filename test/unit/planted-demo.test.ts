import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { checkTestLayers, NO_PROCESS_FOLDERS } from '../../scripts/check-test-layers.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';

// The planted-defect sample of /brew-review (its README). The patches are data, never applied
// here: this reads the lines they add.
const sample = join(import.meta.dirname, '..', 'fixtures', 'brew-review', 'planted-demo');

// The lines each patch adds, by the path of the file it adds them to.
const addedLines = (patch: string): Map<string, string[]> => {
  const added = new Map<string, string[]>();
  let file: string | undefined;
  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) file = undefined;
    else if (line.startsWith('+++ b/')) file = line.slice('+++ b/'.length);
    else if (file !== undefined && line.startsWith('+')) {
      added.set(file, [...(added.get(file) ?? []), line.slice(1)]);
    }
  }
  return added;
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
      for (const [file, lines] of addedLines(readFileSync(join(sample, name), 'utf8'))) {
        files.set(file, [...(files.get(file) ?? []), ...lines]);
      }
    }
    testFiles = [...files.keys()].filter((file) => file.startsWith('test/'));
    for (const file of testFiles) {
      const path = join(tree.path, ...file.split('/'));
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${files.get(file)?.join('\n')}\n`);
    }
  });

  after(() => tree.remove());

  // Its tests pass without any mutant, so a mutation check on the sample compares the review,
  // not a fixture that fails at its head (#43). The planted process start is in the code (0006).
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
