// TAP, the Test Anything Protocol (versions 13 and 14, with indented subtests), as a test report
// for the red proof (ADR 0078). Pure.

import {
  type ReadReport,
  type ReportedTest,
  type TestLocation,
  type TestResult,
  testLocation,
} from './test-report.ts';

// `ok`, `not ok`, an optional number, then the description and directive, at any indent.
const TEST_POINT = /^( *)(not )?ok\b(?: +\d+)?(?: +-)?(?: +(.*))?$/;
const BAIL_OUT = /^ *Bail out!(?: +(.*))?$/;
// The comment node (and TAP 14) writes before each test, naming it: no text outside the tests.
const SUBTEST = /^ *# Subtest: /;
// A directive follows the first `#` that is not escaped.
const DIRECTIVE = /^(skip|todo)\b/i;

/** The description and directive of a test point, split at the first unescaped `#`. */
function describePoint(rest: string): { name: string; directive: string | undefined } {
  let name = '';
  for (let index = 0; index < rest.length; index++) {
    const char = rest[index];
    if (char === '\\' && index + 1 < rest.length) {
      name += rest[index + 1];
      index++;
    } else if (char === '#') {
      return { name: name.trim(), directive: rest.slice(index + 1).trim() };
    } else {
      name += char;
    }
  }
  return { name: name.trim(), directive: undefined };
}

/**
 * The place a diagnostic block's `location` names: a YAML scalar, single-quoted as node writes it
 * (`'/work/app/add.test.mjs:4:1'`), double-quoted or plain, of a file and, after it, a line and a
 * column.
 */
function locationOf(value: string): TestLocation | undefined {
  const quote = value.charAt(0);
  const quoted = quote === "'" || quote === '"';
  if (quoted && (value.length < 2 || !value.endsWith(quote))) return undefined;
  const text = quoted ? value.slice(1, -1) : value;
  const place = quote === "'" ? text.replaceAll("''", "'") : text;
  const at = /:(\d+)(?::\d+)?$/.exec(place);
  return at === null
    ? testLocation(place, undefined)
    : testLocation(place.slice(0, at.index), at[1]);
}

interface Point {
  test: ReportedTest;
  indent: number;
  detail: string[];
}

/** The tests of a TAP stream, or why it is not one. */
export function parseTap(text: string): ReadReport {
  const lines = text.replace(/^﻿/, '').split(/\r\n|\r|\n/);
  const points: Point[] = [];
  const other: string[] = [];
  let bailedOut: string | undefined;
  // The open diagnostic block: the point it belongs to and the indent of its `---`.
  let block: { point: Point; indent: number } | undefined;
  for (const line of lines) {
    if (block !== undefined) {
      const trimmed = line.trim();
      const indent = line.length - line.trimStart().length;
      if (trimmed === '...' && indent === block.indent) {
        block = undefined;
        continue;
      }
      // A block that never closed ends at a line shallower than its `---`.
      if (trimmed === '' || indent >= block.indent) {
        block.point.detail.push(line);
        // A key of the block's own, not a line of a value or a key nested deeper (ADR 0274).
        const { test } = block.point;
        if (indent === block.indent && trimmed.startsWith('location:') && !test.location) {
          const location = locationOf(trimmed.slice('location:'.length).trim());
          if (location !== undefined) test.location = location;
        }
        continue;
      }
      block = undefined;
    }
    const point = TEST_POINT.exec(line);
    if (point !== null) {
      const indent = point[1]?.length ?? 0;
      const { name, directive } = describePoint(point[3] ?? '');
      const skipped = directive !== undefined && DIRECTIVE.test(directive);
      const result: TestResult = skipped ? 'skipped' : point[2] === undefined ? 'passed' : 'failed';
      // The subtests of a point come before it, indented deeper (TAP 14, node).
      const previous = points.at(-1);
      const leaf = previous === undefined || previous.indent <= indent;
      points.push({ test: { name, result, leaf, detail: '' }, indent, detail: [] });
      continue;
    }
    const last = points.at(-1);
    if (last !== undefined && line.trim() === '---' && line.indexOf('---') > last.indent) {
      block = { point: last, indent: line.indexOf('---') };
      continue;
    }
    if (SUBTEST.test(line)) continue;
    const bail = BAIL_OUT.exec(line);
    if (bail !== null) {
      bailedOut = (bail[1] ?? '').trim();
      continue;
    }
    other.push(line);
  }
  if (points.length === 0) return { readable: false, reason: 'it has no TAP test point' };
  const tests = points.map(({ test, detail }) => ({ ...test, detail: detail.join('\n') }));
  return {
    readable: true,
    report: {
      tests,
      other: other.join('\n'),
      ...(bailedOut === undefined ? {} : { bailedOut }),
    },
  };
}
