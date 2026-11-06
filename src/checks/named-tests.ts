// The tests a Gauger named against what a test run's reports hold, the core (ADR 0342): a name the
// reports hold in none of the forms runners write reads as unreported. A name says less than a
// report's place, and a template name matches nothing, so this judges no step: it says so.
// Pure; check-runner.ts reads the reports.

import type { TestReport } from '../formats/test-report.ts';
import { MOST_FAILING_TESTS, type UnreportedTests } from '../schemas/events.ts';
import type { GaugeReport } from '../schemas/out-doc.ts';
import { keptName } from './gravity.ts';

const oneLine = (name: string): string => name.replace(/\s+/g, ' ').trim();

/** Whether `char` carries on a word, so a name beside it is only part of that word. */
const inWord = (char: string | undefined): boolean =>
  char !== undefined && /[\p{L}\p{N}_]/u.test(char);

/** Whether `text` holds `part` as whole words: after a suite or a class, before a case's values. */
const holdsWhole = (text: string, part: string): boolean => {
  for (let at = text.indexOf(part); at !== -1; at = text.indexOf(part, at + 1)) {
    if (!inWord(text[at - 1]) && !inWord(text[at + part.length])) return true;
  }
  return false;
};

/** Whether `text` ends with `part` as whole words: a name a brewer wrote with its suite or path. */
const endsWhole = (text: string, part: string): boolean =>
  text.endsWith(part) && !inWord(text[text.length - part.length - 1]);

/**
 * The names of `named` that `reports` hold under no name of theirs: each compared on one line, and
 * held in a report's name, or ending with one, as whole words. Any test counts, whatever its result,
 * since this asks whether the run reported it.
 */
export function unreportedNames(
  named: GaugeReport,
  reports: readonly TestReport[],
): readonly string[] {
  const held = reports
    .flatMap(({ tests }) => tests.map(({ name }) => oneLine(name)))
    .filter(Boolean);
  return [...named.tests, ...named.regressionTests].filter((name) => {
    const line = oneLine(name);
    return line !== '' && !held.some((each) => holdsWhole(each, line) || endsWhole(line, each));
  });
}

/**
 * `names` as a step's record keeps them, as a failing test's name is kept (ADR 0304): each once, on
 * one line, left out when it looks like a secret, cut, and the most a reading names with a count of
 * the rest. A brewer wrote them.
 */
export function unreportedRecord(names: readonly string[]): UnreportedTests {
  const kept = [...new Set(names.map((name) => keptName(name)))];
  const tests = kept.slice(0, MOST_FAILING_TESTS);
  return { tests, more: kept.length - tests.length };
}
