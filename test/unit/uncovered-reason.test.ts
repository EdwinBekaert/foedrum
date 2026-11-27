// The uncovered-line check's reason (ADR 0428): each file named once with the ranges of its lines,
// read from the lines as the judging hands them over, in any order and interleaved across files.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type UncoveredLine, uncoveredReason } from '../../src/checks/uncovered.ts';

const line = (file: string, number: number, branch = false): UncoveredLine => ({
  file,
  line: number,
  branch,
});

describe('uncoveredReason', () => {
  it('sorts a file’s lines before it merges them into ranges, whatever order they arrive in', () => {
    assert.equal(
      uncoveredReason([
        line('src/a.ts', 9),
        line('src/a.ts', 3),
        line('src/a.ts', 8),
        line('src/a.ts', 2),
      ]),
      '4 changed lines no test runs, all in src/a.ts: lines 2–3, 8–9',
    );
  });

  it('names each file once with its own ranges, though its lines come interleaved with another file’s', () => {
    assert.equal(
      uncoveredReason([
        line('src/b.ts', 11),
        line('src/a.ts', 5),
        line('src/b.ts', 10),
        line('src/a.ts', 4),
        line('src/b.ts', 2),
        line('src/a.ts', 20),
      ]),
      '6 changed lines no test runs: src/b.ts: lines 2, 10–11; src/a.ts: lines 4–5, 20',
    );
  });

  it('keeps a branch line apart from the range beside it, wherever it arrives', () => {
    assert.equal(
      uncoveredReason([line('src/a.ts', 7), line('src/a.ts', 5), line('src/a.ts', 6, true)]),
      '3 changed lines no test runs, all in src/a.ts: lines 5, 6 (branch not taken), 7',
    );
  });

  it('says line, not lines, of a file with a single one among others with several', () => {
    assert.equal(
      uncoveredReason([line('src/a.ts', 3), line('src/b.ts', 4), line('src/a.ts', 2)]),
      '3 changed lines no test runs: src/a.ts: lines 2–3; src/b.ts: line 4',
    );
  });
});
