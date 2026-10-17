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
    assert.equal(invalid.lines[0], 'mutant 1: invalid: the replacement adds c');
    assert.deepEqual(await applyMutant(tree, answer, 2), {
      ok: false,
      lines: ['mutant 2: no such mutant (the answer has 1)'],
    });
    assert.equal(read(), source);
  });

  it('says why it cannot read an answer that is not JSON, for checking and applying', async () => {
    writeFileSync(answer, '{ "mutants": [ ');
    const checked = await checkMutants(tree, answer);
    assert.equal(checked.ok, false);
    assert.match(checked.lines[0] ?? '', /^cannot read the answer:/);
    const applied = await applyMutant(tree, answer, 1);
    assert.equal(applied.ok, false);
    assert.match(applied.lines[0] ?? '', /^cannot read the answer:/);
  });

  it('refuses a mutant number that is not a whole number', async () => {
    write({ mutants: [valid] });
    for (const n of [Number.NaN, 1.5]) {
      assert.deepEqual(await applyMutant(tree, answer, n), {
        ok: false,
        lines: [`mutant ${n}: no such mutant (the answer has 1)`],
      });
    }
    assert.equal(read(), source);
  });

  it('marks a mutant whose file is a folder invalid and still checks the others', async () => {
    mkdirSync(join(tree, 'src', 'engine'));
    write({ mutants: [{ ...valid, file: 'src/engine' }, valid] });
    const result = await checkMutants(tree, answer).catch((error: Error) => error.message);
    assert.deepEqual(result, {
      ok: true,
      lines: ['mutant 1: invalid: src/engine is not a file', 'mutant 2: valid src/add.ts:2'],
    });
  });

  it('checks and applies a mutant of a file under scripts/', async () => {
    mkdirSync(join(tree, 'scripts'));
    writeFileSync(join(tree, 'scripts', 'add.ts'), source);
    write({ mutants: [{ ...valid, file: 'scripts/add.ts' }] });
    assert.deepEqual(await checkMutants(tree, answer), {
      ok: true,
      lines: ['mutant 1: valid scripts/add.ts:2'],
    });
    assert.deepEqual(await applyMutant(tree, answer, 1), {
      ok: true,
      lines: ['mutant 1: applied scripts/add.ts:2'],
    });
    assert.equal(
      readFileSync(join(tree, 'scripts', 'add.ts'), 'utf8'),
      source.replace('a + b', 'a - b'),
    );
    assert.equal(read(), source);
  });

  it('refuses a mutant of scripts/ when the tree’s scripts/ is a link or leads out', async () => {
    symlinkSync(join(dir.path, 'outside'), join(tree, 'scripts'), 'junction');
    write({ mutants: [{ ...valid, file: 'scripts/add.ts' }, valid] });
    assert.deepEqual(await checkMutants(tree, answer), {
      ok: true,
      lines: [
        'mutant 1: invalid: the tree’s scripts/ is not a folder of its own',
        'mutant 2: valid src/add.ts:2',
      ],
    });
    assert.equal((await applyMutant(tree, answer, 1)).ok, false);
    assert.equal(readFileSync(join(dir.path, 'outside', 'add.ts'), 'utf8'), source);
  });

  it('refuses a mutant of a link inside scripts/ that leads out of it', async () => {
    mkdirSync(join(tree, 'scripts'));
    symlinkSync(join(dir.path, 'outside'), join(tree, 'scripts', 'linked'), 'junction');
    write({ mutants: [{ ...valid, file: 'scripts/linked/add.ts' }] });
    const result = await checkMutants(tree, answer);
    assert.match(
      result.lines[0] ?? '',
      /^mutant 1: invalid: scripts\/linked\/add\.ts is not inside the tree's scripts\//,
    );
  });

  it('refuses every mutant when the tree’s src/ is a link, so no edit can leave the tree', async () => {
    const linked = join(dir.path, 'linked-tree');
    mkdirSync(linked);
    symlinkSync(join(dir.path, 'outside'), join(linked, 'src'), 'junction');
    write({ mutants: [valid] });
    assert.deepEqual(await checkMutants(linked, answer), {
      ok: true,
      lines: ['mutant 1: invalid: the tree’s src/ is not a folder of its own'],
    });
    assert.equal((await applyMutant(linked, answer, 1)).ok, false);
    assert.equal(readFileSync(join(dir.path, 'outside', 'add.ts'), 'utf8'), source);
  });

  it('marks a mutant of a file the change does not touch invalid, for checking and applying', async () => {
    write({ mutants: [valid] });
    const files = join(dir.path, 'files.txt');
    writeFileSync(files, 'M\tsrc/other.ts\n');
    const invalid = 'mutant 1: invalid: "src/add.ts" is not a file the change touches';
    assert.deepEqual(await checkMutants(tree, answer, files), { ok: true, lines: [invalid] });
    assert.deepEqual(await applyMutant(tree, answer, 1, files), { ok: false, lines: [invalid] });
    assert.equal(read(), source);
    writeFileSync(files, 'M\tsrc/add.ts\n');
    assert.deepEqual(await checkMutants(tree, answer, files), {
      ok: true,
      lines: ['mutant 1: valid src/add.ts:2'],
    });
  });

  it('fails when the list of the files the change touches cannot be read', async () => {
    write({ mutants: [valid] });
    const missing = join(dir.path, 'missing.txt');
    for (const result of [
      await checkMutants(tree, answer, missing),
      await applyMutant(tree, answer, 1, missing),
    ]) {
      assert.equal(result.ok, false);
      assert.match(result.lines.join('\n'), /^cannot read the changed files: /);
    }
    assert.equal(read(), source);
  });
});
