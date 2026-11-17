// What a person reads first of a ready pull request, and the review effort (ADR 0422): from the
// push's recorded size and the files of the Tasters' findings, with no model.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFirstLine, reviewEffortOf, sizeOf } from '../../src/engine/read-first.ts';

describe('sizeOf: the size the push records (ADR 0422)', () => {
  it('adds up the lines and files of a change, the largest first, ties by path', () => {
    assert.deepEqual(
      sizeOf([
        { path: 'src/b.ts', lines: 10 },
        { path: 'src/c.ts', lines: 40 },
        { path: 'src/a.ts', lines: 10 },
      ]),
      {
        lines: 60,
        files: 3,
        largest: [
          { path: 'src/c.ts', lines: 40 },
          { path: 'src/a.ts', lines: 10 },
          { path: 'src/b.ts', lines: 10 },
        ],
      },
    );
  });

  it('leaves lock files out of the lines, the files and the largest', () => {
    assert.deepEqual(
      sizeOf([
        { path: 'package-lock.json', lines: 4_000 },
        { path: 'web/Cargo.lock', lines: 90 },
        { path: 'src/a.ts', lines: 7 },
      ]),
      { lines: 7, files: 1, largest: [{ path: 'src/a.ts', lines: 7 }] },
    );
  });

  it('counts a binary file among the files, with no lines, and never names it among the largest', () => {
    assert.deepEqual(sizeOf([{ path: 'logo.png' }, { path: 'src/a.ts', lines: 3 }]), {
      lines: 3,
      files: 2,
      largest: [{ path: 'src/a.ts', lines: 3 }],
    });
  });

  it('names the 100 largest files and counts the rest in the lines and files', () => {
    const files = Array.from({ length: 105 }, (_, n) => ({
      path: `src/f${String(n).padStart(3, '0')}.ts`,
      lines: n + 1,
    }));
    const size = sizeOf(files);
    assert.equal(size?.files, 105);
    assert.equal(size?.lines, (105 * 106) / 2);
    assert.equal(size?.largest.length, 100);
    assert.deepEqual(size?.largest[0], { path: 'src/f104.ts', lines: 105 });
    assert.deepEqual(size?.largest.at(-1), { path: 'src/f005.ts', lines: 6 });
  });

  it('records no size for a change of lock files only', () => {
    assert.equal(sizeOf([{ path: 'package-lock.json', lines: 12 }]), undefined);
    assert.equal(sizeOf([]), undefined);
  });
});

describe('effortOf: the review effort by changed lines (ADR 0422)', () => {
  it('is 1 for up to 50 lines', () => {
    assert.equal(reviewEffortOf(0), 1);
    assert.equal(reviewEffortOf(50), 1);
  });

  it('is 2 for 51 to 200 lines', () => {
    assert.equal(reviewEffortOf(51), 2);
    assert.equal(reviewEffortOf(200), 2);
  });

  it('is 3 for 201 to 400 lines', () => {
    assert.equal(reviewEffortOf(201), 3);
    assert.equal(reviewEffortOf(400), 3);
  });

  it('is 4 for 401 to 1000 lines', () => {
    assert.equal(reviewEffortOf(401), 4);
    assert.equal(reviewEffortOf(1_000), 4);
  });

  it('is 5 past 1000 lines', () => {
    assert.equal(reviewEffortOf(1_001), 5);
    assert.equal(reviewEffortOf(50_000), 5);
  });
});

describe('readFirstLine: the merge brief line (ADR 0422)', () => {
  const size = {
    lines: 312,
    files: 7,
    largest: [
      { path: 'src/big.ts', lines: 150 },
      { path: 'src/mid.ts', lines: 80 },
      { path: 'src/b.ts', lines: 40 },
      { path: 'src/a.ts', lines: 40 },
      { path: 'src/small.ts', lines: 2 },
    ],
  };

  it('names the largest changes first when no finding names a file', () => {
    assert.equal(
      readFirstLine(size, []),
      '**Read first:** src/big.ts, src/mid.ts, src/a.ts · effort 3 of 5 (312 changed lines in 7 files).',
    );
  });

  it('names the files the findings point at most before the largest changes', () => {
    assert.equal(
      readFirstLine(size, ['src/small.ts', 'src/b.ts', 'src/small.ts', undefined]),
      '**Read first:** src/small.ts, src/b.ts, src/big.ts · effort 3 of 5 (312 changed lines in 7 files).',
    );
  });

  it('orders files with as many findings by their changed lines, then by path', () => {
    assert.equal(
      readFirstLine(size, ['src/a.ts', 'src/small.ts', 'src/b.ts', 'src/mid.ts']),
      '**Read first:** src/mid.ts, src/a.ts, src/b.ts · effort 3 of 5 (312 changed lines in 7 files).',
    );
  });

  it('counts no finding on a file the push did not record', () => {
    assert.equal(
      readFirstLine(size, ['src/elsewhere.ts', 'src/elsewhere.ts', 'src/small.ts']),
      '**Read first:** src/small.ts, src/big.ts, src/mid.ts · effort 3 of 5 (312 changed lines in 7 files).',
    );
  });

  it("counts a finding's file written with a leading ./ or with backslashes as the path git gave", () => {
    assert.equal(
      readFirstLine(size, ['./src/small.ts', String.raw`src\small.ts`, 'src/b.ts']),
      '**Read first:** src/small.ts, src/b.ts, src/big.ts · effort 3 of 5 (312 changed lines in 7 files).',
    );
  });

  it('names one file of a one-file change', () => {
    assert.equal(
      readFirstLine({ lines: 12, files: 1, largest: [{ path: 'src/a.ts', lines: 12 }] }, []),
      '**Read first:** src/a.ts · effort 1 of 5 (12 changed lines in 1 file).',
    );
  });

  it('gives only the effort when no file has lines to name', () => {
    assert.equal(
      readFirstLine({ lines: 0, files: 1, largest: [] }, []),
      '**Effort:** 1 of 5 (0 changed lines in 1 file).',
    );
  });

  it('escapes each path as plain text', () => {
    assert.equal(
      readFirstLine({ lines: 1, files: 1, largest: [{ path: 'src/<b>_x.ts', lines: 1 }] }, []),
      '**Read first:** src/&lt;b&gt;\\_x.ts · effort 1 of 5 (1 changed line in 1 file).',
    );
  });
});
