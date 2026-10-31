// The red proof's verdict, the core (ADR 0017): whether the run shows the behaviour a step's tests
// describe missing. With a test map, by checks that read no test name (judgeMapped, ADR 0274);
// without one, by the tests a step committed, found by name (judgeRed, ADR 0078). Pure;
// check-runner.ts runs the tests and reads the reports and the step's diff.

import { posix } from 'node:path';
import { isAbsolutePath, reportPath } from '../formats/coverage-report.ts';
import type { ReportedTest, TestReport } from '../formats/test-report.ts';
import type { DiffFile } from '../formats/unified-diff.ts';
import { areaOf, type EffectiveModule } from './test-map.ts';
import { assertsOnly, isTestFile } from './tests-unchanged.ts';

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
  // .NET's, as an exception's text: `System.IO.FileLoadException : …` (xunit) or `…Exception: …`.
  // `typeof(System.TypeLoadException)` or a quoted message in a failed assertion is no load error,
  // nor a FileNotFoundException of a file (#679).
  /\bSystem\.(?:IO\.FileLoadException|BadImageFormatException|TypeLoadException) ?:/,
  /\bSystem\.IO\.FileNotFoundException ?: Could not load file or assembly\b/,
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
 * Whether a line the step added declares the test `name`, as a declaration writes a test's name
 * (ADR 0176): as the whole of a string literal (`test('adds two numbers'`, `` fun `adds`() ``); as
 * an identifier right before `(` where no call can stand (`void adds(`, ADR 0178); after `def`,
 * `fn` or `func` (`def test_adds`, `fn adds<T>()`); as a GoogleTest macro's test (`TEST(CalcTest,
 * Adds)`); or as the rest of a Gherkin scenario's line (`Scenario: adds two numbers`). A bare word
 * in code (`key: null,`, `f(null)`) is none (#466), nor a method call (`calc.add(`), nor a line
 * that only asserts (`assert.equal(add(1, 2), 3)`). Each form is a literal between fixed parts, so
 * the match stays linear in the line. A line keeps no carriage return of a CRLF file. Without
 * `literals`, a string literal declares nothing: in a file where the step declared no test it is
 * data (ADR 0262).
 */
function declares(name: string, lines: readonly string[], literals = true): boolean {
  const names = namesOf(name);
  const patterns = names.map((each) => {
    const escaped = escapeRegExp(each);
    const forms = [
      `(['"\`])${escaped}\\1`,
      `(?<=\\b(?:def|fn|func) )${escaped}(?![\\p{L}\\p{N}_])`,
      `\\bTEST(?:_F|_P)?\\(\\s*[\\p{L}\\p{N}_]+,\\s*${escaped}\\s*\\)`,
      `^\\s*(?:Scenario(?: Outline| Template)?|Example)\\s*:\\s*${escaped}\\s*$`,
    ].slice(literals ? 0 : 1);
    return new RegExp(forms.join('|'), 'u');
  });
  return lines.some((line) => {
    const text = line.replace(/\r$/, '');
    return (
      !assertsOnly(text) &&
      (patterns.some((pattern) => pattern.test(text)) || names.some((each) => before(each, text)))
    );
  });
}

/** What ends a line's text before a called name: a pair, a character or a word that opens an expression. */
const EXPRESSION_END =
  /(?:=>|->|::|&&|\|\||[=(,[{}<!:+\-/%|^~;]|(?:^|\s)\?|(?<![\p{L}\p{N}_])(?:return|await|yield|throw|raise|new|typeof|in|of|case|else|do|then|if|elif|while|unless|until|when|match|with|defer|go|not|and|or|assert))$/u;

/** The longest word of EXPRESSION_END, plus the character before it and the one before `?`. */
const TAIL = 8;

/**
 * Whether `name(` stands in `text` where a declaration can (ADR 0178): after no letter, digit,
 * underscore or dot, with something before it on the line that does not end in an expression's
 * opening. Each place the name stands is checked, backwards from there only.
 */
function before(name: string, text: string): boolean {
  const call = `${name}(`;
  for (let at = text.indexOf(call); at !== -1; at = text.indexOf(call, at + 1)) {
    if (at > 0 && /[\p{L}\p{N}_.]/u.test(text.charAt(at - 1))) continue;
    let end = at;
    while (end > 0 && /\s/.test(text.charAt(end - 1))) end--;
    if (end > 0 && !EXPRESSION_END.test(text.slice(Math.max(0, end - TAIL), end))) return true;
  }
  return false;
}

/** A line that is a comment, in the languages a Brewery is likely to use; `#[` is a Rust attribute. */
const COMMENT = /^\s*(?:\/\/|\/\*|\*|#(?!\[)|--)/;

/** "test "a"", or "test "a" (and 2 more)". */
const named = (tests: readonly ReportedTest[]): string =>
  `test "${tests[0]?.name}"${tests.length > 1 ? ` (and ${tests.length - 1} more)` : ''}`;

/**
 * Whether `report` proves red the tests that `diff`, the proven step's commits, added; of them,
 * `regressionTests` are the names the step gave its regression tests, which pass (ADR 0170).
 * `testFiles` are the paths of the files that declare a test at the step's tip though no line the
 * step added does, such as a table it added a row to (ADR 0262).
 */
export function judgeRed(
  report: TestReport,
  diff: readonly DiffFile[],
  regressionTests: readonly string[] = [],
  testFiles: ReadonlySet<string> = new Set(),
): RedVerdict {
  const refused = (why: string): RedVerdict => ({ proven: false, why });
  if (report.bailedOut !== undefined) return refused(`the run bailed out: ${report.bailedOut}`);
  const failures = report.tests.filter(({ result }) => result === 'failed');
  const error = loadError([report.other, ...failures.map(({ detail }) => detail)].join('\n'));
  if (error !== undefined) {
    return refused(`the run has a load, compile, import or collection error: ${error}`);
  }
  // A string literal declares a test only in a file that declares one at the step's tip: elsewhere,
  // as in a regenerated schema's `"type": "array"`, it is data (#661, ADR 0262).
  const inTestFile = (file: DiffFile): boolean =>
    isTestFile(file) || (file.newPath !== undefined && testFiles.has(file.newPath));
  const testLines = diff.filter(inTestFile).flatMap(({ added }) => added);
  const otherLines = diff.filter((file) => !inTestFile(file)).flatMap(({ added }) => added);
  const declared = (name: string): boolean =>
    declares(name, testLines) || declares(name, otherLines, false);
  // A suite's own result follows its tests'; its tests are judged.
  const added = report.tests.filter(
    ({ name, leaf }) => leaf && name.trim() !== '' && name.length <= MAX_NAME && declared(name),
  );
  const regression = new Set(regressionTests.map((name) => name.trim()));
  // The lines a regression test may be declared in (ADR 0170): in a file where the step declared a
  // test, whose lines testsUnchanged keeps, and no comment, which declares nothing. Not a file that
  // declares a test only at the tip, whose lines testsUnchanged does not keep (ADR 0262).
  const inTests = diff
    .filter(isTestFile)
    .flatMap(({ added }) => added.filter((line) => !COMMENT.test(line)));
  for (const name of regression) {
    const found = added.filter((test) => test.name.trim() === name && declares(test.name, inTests));
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

/** What a red proof in a repository with a test map judges (ADR 0274). */
export interface MappedRun {
  /** The test report of each module that wrote one. */
  reports: readonly TestReport[];
  /** Why each module the base's map lists counts as a load error: it wrote no report. */
  unreported: readonly string[];
  /** The proven step's commits. */
  diff: readonly DiffFile[];
  /** The effective map's modules. */
  modules: readonly EffectiveModule[];
  /** The worktree's root, which a report's absolute paths start at. */
  root: string;
  /**
   * The root's real path, where a run started in the worktree writes its absolute paths when a
   * link leads to it (macOS's /tmp, a junction), when it differs.
   */
  realRoot?: string;
  /** Whether the worktree's file system takes paths that differ only in case for one. */
  foldCase: boolean;
}

/** A path as the step's files are compared: in either case where the file system folds case. */
const keyOf = (path: string, foldCase: boolean): string => (foldCase ? path.toLowerCase() : path);

/**
 * A test's file relative to the worktree's root with `/` between folders, from either of `roots`
 * (the worktree's path and its real path), or undefined outside both.
 */
const fileOf = ({ location }: ReportedTest, roots: readonly string[]): string | undefined => {
  if (location === undefined) return undefined;
  return roots.map((root) => reportPath(location.file, root)).find((path) => path !== undefined);
};

/** A test's file as a reason shows it: relative to the root, else with `/` between folders. */
const shownFile = (test: ReportedTest, roots: readonly string[]): string =>
  fileOf(test, roots) ?? posix.normalize((test.location?.file ?? '').replaceAll('\\', '/'));

/**
 * The key in `files` (paths by their key) of the file a test's location names: by its path from the
 * root, or, for a relative path a runner may write from a module's folder (pytest from its
 * rootdir), a file whose path ends with it; undefined when it names none of them.
 */
const placedIn = (
  test: ReportedTest,
  files: ReadonlySet<string>,
  roots: readonly string[],
  foldCase: boolean,
): string | undefined => {
  const file = fileOf(test, roots);
  if (file === undefined) return undefined;
  const key = keyOf(file, foldCase);
  if (files.has(key)) return key;
  if (isAbsolutePath(test.location?.file ?? '')) return undefined;
  return [...files].find((each) => each.endsWith(`/${key}`));
};

/**
 * Whether `run` proves the step red, reading no test's name (ADR 0274): checked in this order, the
 * first that fails names why. The run did not bail out; it shows no load error, and every module
 * the base's map lists wrote its reports; the step changed a file in a test area, or in a module
 * whose tests are inline; a test fails, and where the report places every failing test, one lies
 * in such a file; and no skip lies in a line the step added. The base is green, so a failing test
 * is the step's doing, and a passing one is just a passing test.
 */
export function judgeMapped(run: MappedRun): { proven: true } | { proven: false; why: string } {
  const { reports, unreported, diff, modules, root, realRoot, foldCase } = run;
  const roots = realRoot === undefined ? [root] : [root, realRoot];
  const refused = (why: string) => ({ proven: false as const, why });
  const bailedOut = reports.find((report) => report.bailedOut !== undefined)?.bailedOut;
  if (bailedOut !== undefined) return refused(`the run bailed out: ${bailedOut}`);
  const failures = reports.flatMap(({ tests }) =>
    tests.filter(({ result }) => result === 'failed'),
  );
  const text = [...reports.map(({ other }) => other), ...failures.map(({ detail }) => detail)];
  const error = loadError(text.join('\n')) ?? unreported[0];
  if (error !== undefined) {
    return refused(`the run has a load, compile, import or collection error: ${error}`);
  }
  // A file the step changed in a test area: a module's tests, or a module whose tests are inline.
  const inTests = (path: string): boolean => {
    const area = areaOf(modules, path, foldCase);
    if (area?.area === 'tests') return true;
    const module = modules.find(({ module }) => module.name === area?.module)?.module;
    return module !== undefined && 'inline' in module.tests;
  };
  const testFiles = new Set(
    diff.flatMap(({ newPath }) =>
      newPath !== undefined && inTests(newPath) ? [keyOf(newPath, foldCase)] : [],
    ),
  );
  if (testFiles.size === 0) {
    return refused(
      'the step changed no file in a test area of the test map, nor in a module whose tests are inline',
    );
  }
  // A suite's own result follows its tests'.
  const failing = failures.filter(({ leaf }) => leaf);
  if (failing.length === 0) return refused('no test fails, so none shows the behaviour missing');
  // By file: the report places a test at its declaration, which a row added to a table leaves as
  // it was. A failing test the report does not place may be the step's.
  const inChanged = (test: ReportedTest): boolean =>
    placedIn(test, testFiles, roots, foldCase) !== undefined;
  const [placed] = failing;
  if (
    placed !== undefined &&
    failing.every(({ location }) => location !== undefined) &&
    !failing.some(inChanged)
  ) {
    return refused(
      `no failing test lies in a test file the step changed: test "${cut(placed.name)}" fails in ${cut(shownFile(placed, roots))}`,
    );
  }
  const added = new Map(
    diff.flatMap(({ newPath, addedAt }) =>
      newPath === undefined ? [] : [[newPath, new Set(addedAt ?? [])] as const],
    ),
  );
  const skipped = skipsInAddedLines(reports, added, root, foldCase, realRoot);
  return skipped === undefined ? { proven: true } : refused(skipped);
}

/**
 * Why a skip in `reports` is the step's: the report places it in a line `added` holds, by the
 * path relative to `root` (or `realRoot`, the root's real path) with `/` between folders, or by a
 * relative path an added file's path ends with; undefined when none is (ADR 0274). By line: a
 * step's skip sits on a declaration it adds or edits, and a skip the base had is not the step's.
 * A skip the report places on no line is the test-design lens's to find.
 */
export function skipsInAddedLines(
  reports: readonly TestReport[],
  added: ReadonlyMap<string, ReadonlySet<number>>,
  root: string,
  foldCase: boolean,
  realRoot?: string,
): string | undefined {
  const roots = realRoot === undefined ? [root] : [root, realRoot];
  const files = new Map([...added].map(([path, at]) => [keyOf(path, foldCase), { path, at }]));
  const keys = new Set(files.keys());
  for (const test of reports.flatMap(({ tests }) => tests)) {
    const line = test.location?.line;
    if (test.result !== 'skipped' || !test.leaf || line === undefined) continue;
    const file = files.get(placedIn(test, keys, roots, foldCase) ?? '');
    if (file?.at.has(line) === true) {
      return `test "${cut(test.name)}" is skipped at ${cut(file.path)}:${line}, a line the step added, so it proves nothing`;
    }
  }
  return undefined;
}

/** Why a recipe that proves its tests red cannot brew in `repo`: it has no test report. */
export const needsTestReport = (recipe: string, repo: string): string =>
  `recipe ${recipe} proves its tests red, which needs the test report of ${repo}: add "testReport" to its entry in foedrum.jsonc, { "format": "tap" } or { "format": "junit", "path": "<file>" } (ADR 0017)`;
