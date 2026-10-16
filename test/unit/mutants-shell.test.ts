import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { applyMutant, checkMutants } from '../../scripts/mutants.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';

const source = 'export const add = (a, b) => {\n  return a + b;\n};\n';

describe('mutants on a scratch tree', () => {
  let dir: TempDir;
  let tree: string;
  let answer: string;
  const write = (value: unknown): void => writeFileSync(answer, JSON.stringify(value));
  const read = (): string => readFileSync(join(tree, 'src', 'add.ts'), 'utf8');

  const valid = {
    file: 'src/add.ts',
    line: 2,
    original: 'return a + b;',
    replacement: 'return a - b;',
    description: 'subtracts',
  };

  beforeEach(() => {
    dir = makeTempDir('mutants');
    tree = join(dir.path, 'tree');
    answer = join(dir.path, 'brett.json');
    mkdirSync(join(tree, 'src'), { recursive: true });
    writeFileSync(join(tree, 'src', 'add.ts'), source);
    mkdirSync(join(dir.path, 'outside'));
    writeFileSync(join(dir.path, 'outside', 'add.ts'), source);
    symlinkSync(join(dir.path, 'outside'), join(tree, 'src', 'linked'), 'junction');
  });
  afterEach(() => dir.remove());

  it('checks every mutant, says why each invalid one is invalid, and changes nothing', async () => {
    write({
      mutants: [
        valid,
        { ...valid, file: 'test/add.test.ts' },
        { ...valid, original: 'return a * b;' },
        { ...valid, line: 3 },
        { ...valid, file: 'src/missing.ts' },
        { ...valid, file: 'src/linked/add.ts' },
      ],
    });
    const result = await checkMutants(tree, answer);
    assert.equal(result.ok, true);
    assert.equal(result.lines.length, 6);
    assert.equal(result.lines[0], 'mutant 1: valid src/add.ts:2');
    assert.match(result.lines[1] ?? '', /^mutant 2: invalid: .*under src\//);
    assert.equal(result.lines[2], 'mutant 3: invalid: no line of src/add.ts is the original');
    assert.equal(result.lines[3], 'mutant 4: valid src/add.ts:2 (given as line 3)');
    assert.equal(result.lines[4], 'mutant 5: invalid: src/missing.ts does not exist');
    assert.match(result.lines[5] ?? '', /^mutant 6: invalid: src\/linked\/add\.ts is not inside/);
    assert.equal(read(), source);
    assert.equal(readFileSync(join(dir.path, 'outside', 'add.ts'), 'utf8'), source);
  });

  it('fails on an answer that is not Brett’s JSON', async () => {
    writeFileSync(answer, '{ "mutants": [ { "patch": "@@ -1 +1 @@" ');
    assert.equal((await checkMutants(tree, answer)).ok, false);
    write({ patches: [] });
    const result = await checkMutants(tree, answer);
    assert.deepEqual(result, { ok: false, lines: ['the answer has no "mutants" list'] });
  });

  it('applies one valid mutant with an exact line replacement', async () => {
    write({
      mutants: [
        { ...valid, file: 'package.json' },
        { ...valid, line: 9 },
      ],
    });
    assert.deepEqual(await applyMutant(tree, answer, 2), {
      ok: true,
      lines: ['mutant 2: applied src/add.ts:2 (given as line 9)'],
    });
    assert.equal(read(), source.replace('a + b', 'a - b'));
  });

  it('refuses to apply an invalid mutant or one that does not exist, and changes nothing', async () => {
    write({ mutants: [{ ...valid, replacement: 'return a - c;' }] });
    const invalid = await applyMutant(tree, answer, 1);
    assert.equal(invalid.ok, false);
    assert.match(invalid.lines[0] ?? '', /^mutant 1: invalid: .*c/);
    assert.deepEqual(await applyMutant(tree, answer, 2), {
      ok: false,
      lines: ['mutant 2: no such mutant (the answer has 1)'],
    });
    assert.equal(read(), source);
  });
});
