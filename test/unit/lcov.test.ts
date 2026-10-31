// LCOV as the uncovered-line check reads it (ADR 0274): each file's lines with their hits, and
// the branches on them, with paths made relative to the worktree's root.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { CoverageReport } from '../../src/formats/coverage-report.ts';
import { parseLcov } from '../../src/formats/lcov.ts';

const spike = (step: string): string =>
  readFileSync(
    join(import.meta.dirname, '..', 'fixtures', 'coverage-spike', 'ts', step, 'lcov.info'),
    'utf8',
  );

const read = (text: string, root: string): CoverageReport => {
  const parsed = parseLcov(text, root);
  assert.ok(parsed.readable, parsed.readable ? '' : parsed.reason);
  return parsed.report;
};

const lines = (report: CoverageReport, file: string) => [...(report.get(file) ?? new Map())];

describe('parseLcov', () => {
  it("reads LCOV line hits from the spike's calc.ts report", () => {
    // The green step: the RangeError guard (lines 13 and 14) is the only code no test runs.
    const report = read(spike('2-green'), 'C:\\spike\\ts');
    assert.deepEqual([...report.keys()], ['src/calc.ts']);
    const hits = lines(report, 'src/calc.ts').map(([line, { hits }]) => [line, hits]);
    assert.deepEqual(hits, [
      [1, 1],
      [2, 3],
      [3, 3],
      [4, 1],
      [5, 1],
      [6, 3],
      [7, 3],
      [8, 1],
      [9, 3],
      [10, 1],
      [11, 1],
      [12, 2],
      [13, 0],
      [14, 0],
      [15, 2],
      [16, 2],
    ]);
  });

  it('reads LCOV branch data and marks an untaken branch', () => {
    const report = read(spike('2-green'), 'C:\\spike\\ts');
    const calc = report.get('src/calc.ts');
    // multiply's `if (!Number.isFinite(a) || !Number.isFinite(b))` on line 12 never took its guard.
    assert.deepEqual(calc?.get(12), { hits: 2, branches: { taken: 0, total: 1 } });
    assert.deepEqual(calc?.get(6), { hits: 3, branches: { taken: 2, total: 2 } });
    assert.deepEqual(calc?.get(2), { hits: 3 });
    // `-` is a branch whose block never ran; a line's branches are counted across its blocks.
    const dashed = read(
      'SF:a.ts\nDA:3,4\nBRDA:3,0,0,-\nBRDA:3,0,1,4\nBRDA:3,1,0,0\nBRDA:3,1,1,2\nend_of_record\n',
      '/repo',
    );
    assert.deepEqual(dashed.get('a.ts')?.get(3), { hits: 4, branches: { taken: 2, total: 4 } });
  });

  it('takes the highest hit count when LCOV lists a line twice', () => {
    const report = read(
      [
        'SF:src/b.ts',
        'DA:2,0',
        'end_of_record',
        'SF:src/a.ts',
        'DA:2,3',
        'DA:1,0',
        'BRDA:1,0,0,0',
        'end_of_record',
        'SF:src/b.ts',
        'DA:2,7',
        'end_of_record',
        'SF:src/a.ts',
        'DA:1,5',
        'DA:2,1',
        'BRDA:1,0,0,6',
        'end_of_record',
      ].join('\r\n'),
      '/repo',
    );
    assert.deepEqual(lines(report, 'src/a.ts'), [
      [2, { hits: 3 }],
      [1, { hits: 5, branches: { taken: 1, total: 1 } }],
    ]);
    assert.deepEqual(lines(report, 'src/b.ts'), [[2, { hits: 7 }]]);
  });

  it('reads a backslash SF path and a drive letter in either case as one relative path', () => {
    const report = read(
      [
        'SF:c:\\Repo\\src\\a.ts',
        'DA:1,0',
        'end_of_record',
        'SF:C:/Repo/src/a.ts',
        'DA:1,2',
        'end_of_record',
        'SF:src\\deep\\..\\b.ts',
        'DA:1,1',
        'end_of_record',
        // A sibling whose name starts with the root's is outside it, so not in the report.
        'SF:C:\\Repo2\\c.ts',
        'DA:1,1',
        'end_of_record',
      ].join('\n'),
      'C:\\Repo\\',
    );
    assert.deepEqual([...report.keys()], ['src/a.ts', 'src/b.ts']);
    assert.deepEqual(report.get('src/a.ts')?.get(1), { hits: 2 });
    // POSIX paths: the root itself as the folder, and a sibling near miss.
    const posix = read(
      'SF:/home/ada/x.ts\nDA:1,1\nend_of_record\nSF:/home/adam/y.ts\nDA:1,1\nend_of_record\n',
      '/home/ada',
    );
    assert.deepEqual([...posix.keys()], ['x.ts']);
  });

  it('refuses text that is not an LCOV report', () => {
    const refused = parseLcov('Error: Cannot find module\n', '/repo');
    assert.equal(refused.readable, false);
    assert.match(refused.readable ? '' : refused.reason, /no SF record/);
    const malformed = parseLcov('SF:a.ts\nDA:one,1\nend_of_record\n', '/repo');
    assert.equal(malformed.readable, false);
    assert.match(malformed.readable ? '' : malformed.reason, /line 2 is not LCOV/);
  });

  it('names a refused LCOV line by its number, never by its text', () => {
    // The report is the tested code's output: its text stays out of a reason that reaches a status line.
    const planted = `DA:${'x'.repeat(500)}${String.fromCodePoint(0x2028)}forged line`;
    const parsed = parseLcov(['SF:a.ts', 'DA:1,1', planted, 'end_of_record'].join('\n'), '/repo');
    assert.equal(parsed.readable, false);
    assert.equal(parsed.readable ? '' : parsed.reason, 'its line 3 is not LCOV');
  });

  it('compares the root in either case past the drive letter', () => {
    // Windows and macOS tell no case apart: a tool run from a shell in another spelling of the
    // worktree writes it so. The part after the root keeps the tool's spelling.
    const record = (file: string) => [`SF:${file}`, 'DA:1,1', 'end_of_record'].join('\n');
    const windows = read(record('d:\\Code\\Foedrum\\wt\\Src\\a.ts'), 'D:\\code\\foedrum\\wt');
    assert.deepEqual([...windows.keys()], ['Src/a.ts']);
    const mac = read(record('/users/dev/WT/src/b.ts'), '/Users/dev/wt/');
    assert.deepEqual([...mac.keys()], ['src/b.ts']);
  });

  it('leaves out a relative SF path that climbs out of the root', () => {
    const report = read(
      ['SF:../outside.ts', 'SF:..', 'SF:..x/in.ts']
        .flatMap((file) => [file, 'DA:1,1', 'end_of_record'])
        .join('\n'),
      '/repo',
    );
    assert.deepEqual([...report.keys()], ['..x/in.ts']);
  });

  it('reads a DA checksum and a line listed twice in one record, and refuses a malformed BRDA', () => {
    const report = read('SF:a.ts\nDA:1,2,abc123\nDA:2,3\nDA:2,0\nend_of_record\n', '/repo');
    assert.deepEqual(
      [...(report.get('a.ts') ?? [])],
      [
        [1, { hits: 2 }],
        [2, { hits: 3 }],
      ],
    );
    const refused = parseLcov('SF:a.ts\nDA:1,1\nBRDA:x,0,0,1\nend_of_record\n', '/repo');
    assert.equal(refused.readable, false);
    assert.equal(refused.readable ? '' : refused.reason, 'its line 3 is not LCOV');
  });
});
