// The red proof's verdict, the core (ADR 0017): whether the run shows the behaviour a step's tests
// describe missing, by checks that read no test name and a test map (judgeMapped, ADR 0274,
// ADR 0297). Pure; check-runner.ts runs the tests and reads the reports and the step's diff.

import { posix } from 'node:path';
import { isAbsolutePath, reportPath } from '../formats/coverage-report.ts';
import type { ReportedTest, TestReport } from '../formats/test-report.ts';
import type { DiffFile } from '../formats/unified-diff.ts';
import { areaOf, breweryMapPath, type EffectiveModule, TEST_MAP_PATH } from './test-map.ts';

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

/** Longer quotes of a run are cut to this, for the reason that reaches the event log. */
const MAX_QUOTE = 200;

export const cut = (line: string): string =>
  line.length <= MAX_QUOTE ? line : `${line.slice(0, MAX_QUOTE - 1)}…`;

/** The first line of `text` that names a load error, trimmed. */
function loadError(text: string): string | undefined {
  const line = text.split('\n').find((each) => LOAD_ERRORS.some((error) => error.test(each)));
  return line === undefined ? undefined : cut(line.replace(/^\s*#?\s*/, '').trim());
}

/** A module's test report, with the name of the module that wrote it. */
export type MappedReport = TestReport & { module?: string };

/** What a red proof in a repository with a test map judges (ADR 0274). */
export interface MappedRun {
  /** The test report of each module that wrote one. */
  reports: readonly MappedReport[];
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
  /**
   * What the reason adds when no failing test shows the behaviour missing and the run reports some
   * test the step named under no name: why, perhaps, none fails (ADR 0342).
   */
  namedHint?: string;
}

/** A path as the step's files are compared: in either case where the file system folds case. */
const keyOf = (path: string, foldCase: boolean): string => (foldCase ? path.toLowerCase() : path);

/**
 * A test's file relative to the worktree's root with `/` between folders, from either of `roots`
 * (the worktree's path and its real path), or undefined outside both.
 */
export const testFileOf = (
  { location }: ReportedTest,
  roots: readonly string[],
): string | undefined => {
  if (location === undefined) return undefined;
  return roots.map((root) => reportPath(location.file, root)).find((path) => path !== undefined);
};

/** A test's file as a reason shows it: relative to the root, else with `/` between folders. */
const shownFile = (test: ReportedTest, roots: readonly string[]): string =>
  testFileOf(test, roots) ?? posix.normalize((test.location?.file ?? '').replaceAll('\\', '/'));

/**
 * The key in `files` (paths by their key) of the file a test's location names: by its path from the
 * root, or, for a relative path a runner may write from a module's folder (pytest from its
 * rootdir), a file of `ofModule` (the report's module, when known) whose path ends with it;
 * undefined when it names none of them.
 */
const placedIn = (
  test: ReportedTest,
  files: ReadonlySet<string>,
  roots: readonly string[],
  foldCase: boolean,
  ofModule: (key: string) => boolean = () => true,
): string | undefined => {
  const file = testFileOf(test, roots);
  if (file === undefined) return undefined;
  const key = keyOf(file, foldCase);
  if (files.has(key)) return key;
  if (isAbsolutePath(test.location?.file ?? '')) return undefined;
  return [...files].find((each) => each.endsWith(`/${key}`) && ofModule(each));
};

/** Whether a changed file's key is in `module`'s areas: any file when the report names none. */
const inModuleOf =
  (moduleOf: ((path: string) => string | undefined) | undefined, module: string | undefined) =>
  (key: string): boolean =>
    module === undefined || moduleOf === undefined || moduleOf(key) === module;

/**
 * Whether `run` proves the step red, reading no test's name (ADR 0274): checked in this order, the
 * first that fails names why. The run did not bail out; it shows no load error, and every module
 * the base's map lists wrote its reports; the step changed a file in a test area, or in a module
 * whose tests are inline; a test fails, and where the report places every failing test, one lies
 * in such a file; and no skip lies in a line the step added. The base is green, so a failing test
 * is the step's doing, and a passing one is just a passing test.
 */
export function judgeMapped(run: MappedRun): { proven: true } | { proven: false; why: string } {
  const { reports, unreported, diff, modules, root, realRoot, foldCase, namedHint } = run;
  const roots = realRoot === undefined ? [root] : [root, realRoot];
  const refused = (why: string) => ({ proven: false as const, why });
  const hinted = (why: string) => (namedHint === undefined ? why : `${why}: ${namedHint}`);
  const bailedOut = reports.find((report) => report.bailedOut !== undefined)?.bailedOut;
  if (bailedOut !== undefined) return refused(`the run bailed out: ${bailedOut}`);
  const failures = reports.flatMap(({ tests, module }) =>
    tests.filter(({ result }) => result === 'failed').map((test) => ({ ...test, module })),
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
  if (failing.length === 0) {
    return refused(hinted('no test fails, so none shows the behaviour missing'));
  }
  // By file: the report places a test at its declaration, which a row added to a table leaves as
  // it was. A failing test the report does not place may be the step's.
  // A relative place names a file of the module whose report it is in, never another's.
  const moduleOf = (path: string): string | undefined => areaOf(modules, path, foldCase)?.module;
  const inChanged = (test: ReportedTest & { module: string | undefined }): boolean =>
    placedIn(test, testFiles, roots, foldCase, inModuleOf(moduleOf, test.module)) !== undefined;
  const [placed] = failing;
  if (
    placed !== undefined &&
    failing.every(({ location }) => location !== undefined) &&
    !failing.some(inChanged)
  ) {
    return refused(
      hinted(
        `no failing test lies in a test file the step changed: test "${cut(placed.name)}" fails in ${cut(shownFile(placed, roots))}`,
      ),
    );
  }
  const added = new Map(
    diff.flatMap(({ newPath, addedAt }) =>
      newPath === undefined ? [] : [[newPath, new Set(addedAt ?? [])] as const],
    ),
  );
  const skipped = skipsInAddedLines(reports, added, root, foldCase, realRoot, moduleOf);
  return skipped === undefined ? { proven: true } : refused(skipped);
}

/** A skipped test, the added file it lies in as `added` names it, and its line there. */
export interface AddedSkip {
  name: string;
  path: string;
  line: number;
}

/**
 * The first skip in `reports` the report places in a line `added` holds, by the path relative to
 * `root` (or `realRoot`, the root's real path) with `/` between folders, or by a relative path an
 * added file's path ends with, in the report's module by `moduleOf` when both are known; undefined
 * when none is (ADR 0274). By line: a change's skip sits on a declaration it adds or edits, and a
 * skip the base had is not the change's. A skip the report places on no line is the test-design
 * lens's to find.
 */
export function skipInAddedLines(
  reports: readonly MappedReport[],
  added: ReadonlyMap<string, ReadonlySet<number>>,
  root: string,
  foldCase: boolean,
  realRoot?: string,
  moduleOf?: (path: string) => string | undefined,
): AddedSkip | undefined {
  const roots = realRoot === undefined ? [root] : [root, realRoot];
  const files = new Map([...added].map(([path, at]) => [keyOf(path, foldCase), { path, at }]));
  const keys = new Set(files.keys());
  for (const { tests, module } of reports) {
    for (const test of tests) {
      const line = test.location?.line;
      if (test.result !== 'skipped' || !test.leaf || line === undefined) continue;
      const ofModule = inModuleOf(moduleOf, module);
      const file = files.get(placedIn(test, keys, roots, foldCase, ofModule) ?? '');
      if (file?.at.has(line) === true) return { name: test.name, path: file.path, line };
    }
  }
  return undefined;
}

/** Why a skip in `reports` is the red proof's step's (`skipInAddedLines`): undefined when none is. */
export function skipsInAddedLines(
  reports: readonly MappedReport[],
  added: ReadonlyMap<string, ReadonlySet<number>>,
  root: string,
  foldCase: boolean,
  realRoot?: string,
  moduleOf?: (path: string) => string | undefined,
): string | undefined {
  const skip = skipInAddedLines(reports, added, root, foldCase, realRoot, moduleOf);
  return skip === undefined
    ? undefined
    : `test "${cut(skip.name)}" is skipped at ${cut(skip.path)}:${skip.line}, a line the step added, so it proves nothing`;
}

/**
 * Why a recipe that proves its tests red cannot brew in `repo`: it has no test map, kept where
 * `keptIn` says (ADR 0297).
 */
export const needsTestMap = (recipe: string, repo: string, keptIn: 'repo' | 'brewery'): string => {
  const needs = `recipe ${recipe} proves its tests red, which needs a test map of ${repo}`;
  return keptIn === 'brewery'
    ? `${needs}: the Brewery keeps it and has none, so add ${breweryMapPath(repo)} to the Brewery (ADR 0297)`
    : `${needs}: commit ${TEST_MAP_PATH} to ${repo}, or add a survey step to the recipe (ADR 0297)`;
};
