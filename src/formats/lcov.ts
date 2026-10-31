// LCOV as a coverage report (ADR 0274): `SF` starts a file, `DA` a line, `BRDA` a branch,
// `end_of_record` ends the file. Pure.

import {
  addLine,
  type CoveredLine,
  linesOf,
  type ReadCoverage,
  reportPath,
} from './coverage-report.ts';

// `DA:<line>,<hits>[,<checksum>]` and `BRDA:<line>,<block>,<branch>,<taken>`, `-` for a block
// that never ran.
const DA = /^DA:(\d+),(\d+)(?:,[^,]*)?$/;
const BRDA = /^BRDA:(\d+),[^,]+,[^,]+,(\d+|-)$/;

/** The lines of an LCOV report, its paths relative to `root`, or why it is not one. */
export function parseLcov(text: string, root: string): ReadCoverage {
  const files = new Map<string, Map<number, CoveredLine>>();
  let record:
    | {
        file: string;
        hits: Map<number, number>;
        branches: Map<number, NonNullable<CoveredLine['branches']>>;
      }
    | undefined;
  const end = (): void => {
    if (record === undefined) return;
    const lines = linesOf(files, record.file);
    // Only the lines LCOV lists as executable: a branch on any other line is not judged.
    for (const [number, hits] of record.hits) {
      const branches = record.branches.get(number);
      addLine(lines, number, branches === undefined ? { hits } : { hits, branches });
    }
    record = undefined;
  };
  for (const raw of text.replace(/^﻿/, '').split('\n')) {
    const line = raw.trim();
    if (line.startsWith('SF:')) {
      end();
      record = { file: reportPath(line.slice(3), root), hits: new Map(), branches: new Map() };
    } else if (line === 'end_of_record') {
      end();
    } else if (record !== undefined && line.startsWith('DA:')) {
      const [, number = '', hits = ''] = DA.exec(line) ?? [];
      if (number === '') return { readable: false, reason: `its line "${line}" is not LCOV` };
      const at = Number(number);
      record.hits.set(at, Math.max(record.hits.get(at) ?? 0, Number(hits)));
    } else if (record !== undefined && line.startsWith('BRDA:')) {
      const [, number = '', taken = ''] = BRDA.exec(line) ?? [];
      if (number === '') return { readable: false, reason: `its line "${line}" is not LCOV` };
      const at = Number(number);
      const had = record.branches.get(at) ?? { taken: 0, total: 0 };
      const ran = taken !== '-' && Number(taken) > 0;
      record.branches.set(at, { taken: had.taken + (ran ? 1 : 0), total: had.total + 1 });
    }
  }
  end();
  if (files.size === 0) return { readable: false, reason: 'it has no SF record' };
  return { readable: true, report: files };
}
