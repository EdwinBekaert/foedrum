// The red proof's verdict, the core (ADR 0017, ADR 0078): whether a test report shows the tests a
// step committed failing because the behaviour is missing. Pure; check-runner.ts runs the tests
// and reads the report and the step's diff.

import type { ReportedTest, TestReport } from '../formats/test-report.ts';
import type { DiffFile } from '../formats/unified-diff.ts';
import { assertsOnly } from './tests-unchanged.ts';

export type RedVerdict =
  /** `tests`: the names of the proven step's tests, all failing. */
  { proven: true; tests: readonly string[] } | { proven: false; why: string };

/**
 * What a run says when a test did not load, compile, import or get collected, in the languages
 * and runners a Brewery is likely to use. A test that fails with one of these never reached the
 * behaviour it tests, so it does not prove the behaviour is missing, even when the code under test
 * threw it: a Gauger that tests such an error asserts on it instead.
 */
const LOAD_ERRORS: readonly RegExp[] = [
  /\bSyntaxError\b/,
  /\bReferenceError\b/,
  /\bCannot find module\b/i,
  /\bERR_MODULE_NOT_FOUND\b/,
  /\bdoes not provide an export named\b/,
  /\bTest suite failed to run\b/,
  /\bModuleNotFoundError\b/,
  /\bImportError\b/,
  /\bNameError\b/,
  /\bERROR collecting\b/,
  /\berrors? during collection\b/i,
  /\bcollection (?:failure|error)\b/i,
  /\berror TS\d+\b/,
  /\berror CS\d+\b/,
  /\bcannot find symbol\b/,
  /\bNoClassDefFoundError\b/,
  /\bClassNotFoundException\b/,
  /\bcompil(?:e|ation) (?:error|failed|failure)\b/i,
  /\b(?:failed to|could not) compile\b/i,
];

/**
 * A reported name longer than this is no declaration: the names come from code a brewer wrote,
 * and each is matched against every line the step added.
 */
const MAX_NAME = 1000;

/** Longer quotes of a run are cut to this, for the reason that reaches the event log. */
const MAX_QUOTE = 200;

export const cut = (line: string): string =>
  line.length <= MAX_QUOTE ? line : `${line.slice(0, MAX_QUOTE - 1)}…`;

/** The first line of `text` that names a load error, trimmed. */
function loadError(text: string): string | undefined {
  const line = text.split('\n').find((each) => LOAD_ERRORS.some((error) => error.test(each)));
  return line === undefined ? undefined : cut(line.replace(/^\s*#?\s*/, '').trim());
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The forms of a test's name its declaration may have: the name, without the parameters a runner
 * adds (`(int, int)`, `[1]`), its last part after suite titles (`the calculator > adds`), and that
 * part's last part after a class or module (`AddTest.adds`). A class or module holds no space, so
 * a sentence with a dot (`… with git.commit`) has no last part; a suite title may.
 */
function namesOf(name: string): string[] {
  let bare = name.trim();
  for (let shorter = bare; ; bare = shorter) {
    shorter = bare.replace(/\s*(?:\([^()]*\)|\[[^[\]]*\])$/, '');
    if (shorter === bare) break;
  }
  const test = bare.split(/\s>\s/).at(-1)?.trim() ?? '';
  const parts = test.split(/::|[.#/\\]/).map((part) => part.trim());
  const last = parts.slice(0, -1).some((part) => /\s/.test(part)) ? '' : (parts.at(-1) ?? '');
  const names = [name.trim(), bare, ...[test, last].filter((each) => each.length >= 3)];
  return [...new Set(names)].filter((each) => each !== '');
}

/**
 * Whether a line the step added declares the test `name`: the name stands as a whole, after
 * something that is no letter, digit, underscore or dot, and before something that is none of
 * those nor a space, or the line's end, as a declaration writes it (`test('adds two numbers'`,
 * `def test_adds(`, `void adds(`). A call (`calc.add(`) is none, and neither is a line that only
 * asserts (`assert.equal(add(1, 2), 3)`). A line keeps no carriage return of a CRLF file.
 */
function declares(name: string, lines: readonly string[]): boolean {
  const patterns = namesOf(name).map(
    (each) => new RegExp(`(?<![\\p{L}\\p{N}_.])${escapeRegExp(each)}(?![\\p{L}\\p{N}_\\s])`, 'u'),
  );
  return lines.some((line) => {
    const text = line.replace(/\r$/, '');
    return !assertsOnly(text) && patterns.some((pattern) => pattern.test(text));
  });
}

/** "test "a"", or "test "a" (and 2 more)". */
const named = (tests: readonly ReportedTest[]): string =>
  `test "${tests[0]?.name}"${tests.length > 1 ? ` (and ${tests.length - 1} more)` : ''}`;

/**
 * Whether `report` proves red the tests that `diff`, the proven step's commits, added; of them,
 * `regressionTests` are the names the step gave its regression tests, which pass (ADR 0170).
 */
export function judgeRed(
  report: TestReport,
  diff: readonly DiffFile[],
  regressionTests: readonly string[] = [],
): RedVerdict {
  const refused = (why: string): RedVerdict => ({ proven: false, why });
  if (report.bailedOut !== undefined) return refused(`the run bailed out: ${report.bailedOut}`);
  const failures = report.tests.filter(({ result }) => result === 'failed');
  const error = loadError([report.other, ...failures.map(({ detail }) => detail)].join('\n'));
  if (error !== undefined) {
    return refused(`the run has a load, compile, import or collection error: ${error}`);
  }
  const lines = diff.flatMap(({ added }) => added);
  // A suite's own result follows its tests'; its tests are judged.
  const added = report.tests.filter(
    ({ name, leaf }) =>
      leaf && name.trim() !== '' && name.length <= MAX_NAME && declares(name, lines),
  );
  const regression = new Set(regressionTests.map((name) => name.trim()));
  for (const name of regression) {
    const found = added.filter((test) => test.name.trim() === name);
    const quoted = `regression test "${cut(name)}"`;
    if (found.length === 0) return refused(`${quoted} is not a test the step added in the report`);
    if (found.some(({ result }) => result === 'failed')) {
      return refused(
        `${quoted} fails before the implementation: a regression test passes before the change`,
      );
    }
    if (found.some(({ result }) => result === 'skipped')) {
      return refused(`${quoted} is skipped, so it proves nothing`);
    }
  }
  const proven = added.filter(({ name }) => !regression.has(name.trim()));
  if (proven.length === 0) {
    const besides = regression.size > 0 ? ', besides its regression tests' : '';
    return refused(
      `none of the ${report.tests.length} tests in the report is one the step added${besides}`,
    );
  }
  const passed = proven.filter(({ result }) => result === 'passed');
  if (passed.length > 0) {
    return refused(
      `${named(passed)} passes before the implementation: a stub must throw, not return a value`,
    );
  }
  const skipped = proven.filter(({ result }) => result === 'skipped');
  if (skipped.length > 0) return refused(`${named(skipped)} is skipped, so it proves nothing`);
  return { proven: true, tests: proven.map(({ name }) => name) };
}

/** Why a recipe that proves its tests red cannot brew in `repo`: it has no test report. */
export const needsTestReport = (recipe: string, repo: string): string =>
  `recipe ${recipe} proves its tests red, which needs the test report of ${repo}: add "testReport" to its entry in foedrum.jsonc, { "format": "tap" } or { "format": "junit", "path": "<file>" } (ADR 0017)`;
