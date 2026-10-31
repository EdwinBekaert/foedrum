// The coverage report files of a worktree (ADR 0274): LCOV by file, Cobertura as every
// `coverage.cobertura.xml` under a folder pattern, each read as a test report is (ADR 0078).

import { existsSync, readdirSync } from 'node:fs';
import { join, posix } from 'node:path';
import { type BoundedRead, readOutDocFile } from '../platform/bounded-read.ts';
import { parseCobertura } from './cobertura.ts';
import {
  type CoverageFormat,
  type CoverageReport,
  mergeReports,
  type ReadCoverage,
} from './coverage-report.ts';
import { parseLcov } from './lcov.ts';
import { MAX_REPORT_BYTES } from './test-report.ts';

/** coverlet's collector names every report so, each under a new folder per test project. */
const COBERTURA_FILE = 'coverage.cobertura.xml';

/** The `coverage.cobertura.xml` files under the folders `pattern` matches, relative, sorted. */
function coberturaFiles(root: string, pattern: string): string[] {
  // The walk starts at the folders before the pattern's first glob, not at the whole worktree.
  const parts = pattern.split('/');
  const glob = parts.findIndex((part) => /[*?[{]/.test(part));
  const start = glob < 0 ? parts : parts.slice(0, glob);
  let found: string[];
  try {
    found = readdirSync(join(root, ...start), { recursive: true, encoding: 'utf8' });
  } catch {
    return [];
  }
  const within = `${pattern}/**/${COBERTURA_FILE}`;
  return found
    .map((file) => [...start, ...file.split(/[\\/]/)].join('/'))
    .filter((file) => posix.basename(file) === COBERTURA_FILE && posix.matchesGlob(file, within))
    .sort();
}

/** The coverage at `path`, a file or a folder pattern relative to `root`, or why it is not read. */
export function readCoverage(
  format: CoverageFormat,
  path: string,
  root: string,
  read: (file: string) => BoundedRead = (file) => readOutDocFile(file, MAX_REPORT_BYTES, root),
): ReadCoverage {
  const one = (file: string, parse: (text: string) => ReadCoverage): ReadCoverage | undefined => {
    const text = read(join(root, ...file.split('/')));
    switch (text.kind) {
      case 'missing':
        return undefined;
      case 'unread':
        return { readable: false, reason: `${file}: ${text.reason}` };
      case 'text': {
        const parsed = parse(text.text);
        return parsed.readable ? parsed : { readable: false, reason: `${file}: ${parsed.reason}` };
      }
      default: {
        const unhandled: never = text;
        throw new Error(`Unhandled read ${JSON.stringify(unhandled)}`);
      }
    }
  };
  // Which of several sources a Cobertura filename is under: the one where the file is.
  const there = (file: string): boolean => existsSync(join(root, ...file.split('/')));
  switch (format) {
    case 'lcov':
      return (
        one(path, (text) => parseLcov(text, root)) ?? {
          readable: false,
          reason: `no LCOV report at ${path}`,
        }
      );
    case 'cobertura': {
      const reports: CoverageReport[] = [];
      for (const file of coberturaFiles(root, path)) {
        const parsed = one(file, (text) => parseCobertura(text, root, there));
        // A file gone since the walk is no report of this run.
        if (parsed === undefined) continue;
        if (!parsed.readable) return parsed;
        reports.push(parsed.report);
      }
      if (reports.length === 0) {
        return { readable: false, reason: `no ${COBERTURA_FILE} under ${path}` };
      }
      return { readable: true, report: mergeReports(reports) };
    }
    default: {
      const unhandled: never = format;
      throw new Error(`Unhandled coverage format ${JSON.stringify(unhandled)}`);
    }
  }
}
