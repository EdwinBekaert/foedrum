import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { checkCitations } from '../../scripts/citations.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';

// Twenty lines, like the file whose lines 27 and 34 reviewers cited in #104.
const source = Array.from({ length: 20 }, (_, index) => `line ${index + 1};\n`).join('');

describe('citations in a reviewer answer', () => {
  let dir: TempDir;
  let checkout: string;
  let answer: string;
  const write = (value: unknown): void => writeFileSync(answer, JSON.stringify(value));
  const at = (file: unknown, line: unknown) => ({ severity: 'major', file, line, title: 't' });

  beforeEach(() => {
    dir = makeTempDir('citations');
    checkout = join(dir.path, 'checkout');
    answer = join(dir.path, 'answer.json');
    mkdirSync(join(checkout, 'src', 'engine'), { recursive: true });
    writeFileSync(join(checkout, 'src', 'engine', 'wait.ts'), source);
    mkdirSync(join(dir.path, 'outside'));
    writeFileSync(join(dir.path, 'outside', 'wait.ts'), source);
    symlinkSync(join(dir.path, 'outside'), join(checkout, 'linked'), 'junction');
  });
  afterEach(() => dir.remove());

  it('checks every citation and says why each unverified one is unverified', async () => {
    write({
      lens: 'correctness',
      findings: [
        at('src/engine/wait.ts', 13),
        at('src/engine/wait.ts', 27),
        at('src/engine/missing.ts', 1),
        at(null, null),
        at('../outside/wait.ts', 1),
        at('linked/wait.ts', 1),
        at('src/engine', 1),
        at('src/engine/wait.ts', '13'),
      ],
    });
    assert.deepEqual(await checkCitations(checkout, answer), {
      ok: true,
      lines: [
        'finding 1: ok src/engine/wait.ts:13',
        'finding 2: unverified: src/engine/wait.ts has 20 lines, not 27',
        'finding 3: unverified: src/engine/missing.ts does not exist',
        'finding 4: no location',
        'finding 5: unverified: "../outside/wait.ts" is not a path in the repository',
        'finding 6: unverified: linked/wait.ts is not inside the checkout',
        'finding 7: unverified: src/engine is not a file',
        'finding 8: unverified: "line" is not a line number',
      ],
    });
  });

  it('checks the proposals of simplify the same way', async () => {
    write({ proposals: [{ file: 'src/engine/wait.ts', line: 20, why: 'w', patch: 'p' }] });
    assert.deepEqual(await checkCitations(checkout, answer), {
      ok: true,
      lines: ['finding 1: ok src/engine/wait.ts:20'],
    });
  });

  it('reads an answer that starts with a byte order mark', async () => {
    writeFileSync(answer, `﻿${JSON.stringify({ findings: [at('src/engine/wait.ts', 1)] })}`);
    assert.deepEqual(await checkCitations(checkout, answer), {
      ok: true,
      lines: ['finding 1: ok src/engine/wait.ts:1'],
    });
  });

  it('says a path in the wrong case does not exist, on every file system', async () => {
    write({ findings: [at('SRC/Engine/wait.ts', 1)] });
    assert.deepEqual(await checkCitations(checkout, answer), {
      ok: true,
      lines: ['finding 1: unverified: SRC/Engine/wait.ts does not exist'],
    });
  });

  it('fails on an answer that cannot be read or has no findings list', async () => {
    writeFileSync(answer, '{ "findings": [ ');
    const unreadable = await checkCitations(checkout, answer);
    assert.equal(unreadable.ok, false);
    assert.match(unreadable.lines[0] ?? '', /^cannot read the answer:/);
    write({ verdict: 'approve' });
    assert.deepEqual(await checkCitations(checkout, answer), {
      ok: false,
      lines: ['the answer has no "findings" or "proposals" list'],
    });
  });
});
