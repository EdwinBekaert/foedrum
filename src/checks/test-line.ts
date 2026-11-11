// What a Brewery's test line saves, read from the line alone and never run (ADR 0376): the test
// runners Foedrum knows, whether the line saves a test report, the line with the flags that save
// one, and what a runner needs a package for. `foedrum init` writes the line with it and
// `foedrum doctor` warns with it.

/** The test runners Foedrum knows in a test line (ADR 0376). */
export type TestRunner = 'node' | 'vitest' | 'pytest' | 'dotnet';

export interface TestLine {
  /** `undefined` for a runner Foedrum does not know, or a line of more than one command. */
  runner: TestRunner | undefined;
  /** Whether the line saves a test report already. */
  saves: boolean;
  /** The line with the flags that save a report, when it saves none and flags alone can. */
  withReport?: string;
  /** What to add, one line each, for a report or for coverage that needs a package. */
  advice: readonly string[];
}

/**
 * The flags after `node --test`, before its files: node reads a flag after the first file as the
 * test's own argument, and does not create a destination's folder, so the reports go at the root.
 */
const NODE_REPORTS =
  '--experimental-test-coverage --test-reporter=spec --test-reporter-destination=stdout --test-reporter=junit --test-reporter-destination=junit.xml --test-reporter=lcov --test-reporter-destination=lcov.info';

/** vitest's flags, which it reads after `npm test --` as well as on its own line. */
const VITEST_REPORTS = '--reporter=default --reporter=junit --outputFile.junit=junit.xml';

const PYTEST_REPORT = '--junit-xml=junit.xml';

const UNTIL = 'until then the Maltster maps it with "coverage": "none"';

const COVERAGE: Readonly<Record<'vitest' | 'pytest' | 'dotnet', string>> = {
  vitest: `for coverage, add @vitest/coverage-v8 to the repository, then --coverage --coverage.reporter=lcov to the test line; ${UNTIL}`,
  pytest: `for coverage, add pytest-cov to the repository, then --cov --cov-report=lcov:lcov.info to the test line; ${UNTIL}`,
  dotnet: `for coverage, add coverlet.collector to each test project (dotnet's test templates have it), then --collect:"XPlat Code Coverage" to the test line; ${UNTIL}`,
};

const DOTNET_REPORT =
  'for a test report Foedrum reads, add JunitXml.TestLogger to each test project, then --logger:"junit;LogFilePath=TestResults/{assembly}.junit.xml" to the test line';

/** What `foedrum init` says of a line whose runner it does not know. */
const UNKNOWN_RUNNER =
  "Foedrum does not know this test runner and added no report settings; the line must save a JUnit or TAP test report, and LCOV or Cobertura coverage or none; the first test-first order's survey checks it";

interface Word {
  text: string;
  end: number;
}

/**
 * The words of `line`, quotes taken off, each with where it ends; `undefined` when an unquoted
 * `;`, `|` or `&` joins it to another command, which Foedrum does not read.
 */
const wordsOf = (line: string): Word[] | undefined => {
  const words: Word[] = [];
  let text = '';
  let quote: string | undefined;
  let inWord = false;
  for (let at = 0; at < line.length; at++) {
    const char = line[at] ?? '';
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      else text += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      inWord = true;
    } else if (char === ';' || char === '|' || char === '&') {
      return undefined;
    } else if (/\s/.test(char)) {
      if (inWord) words.push({ text, end: at });
      text = '';
      inWord = false;
    } else {
      text += char;
      inWord = true;
    }
  }
  if (inWord) words.push({ text, end: line.length });
  return words;
};

/** The runner the words run, by the first one that names it. */
const runnerOf = (words: readonly Word[]): TestRunner | undefined => {
  const texts = words.map(({ text }) => text);
  if (/^node(?:\.exe)?$/.test(texts[0] ?? '') && texts.includes('--test')) return 'node';
  if (texts.some((text) => text === 'vitest' || text.startsWith('--outputFile.junit='))) {
    return 'vitest';
  }
  if (texts.includes('pytest')) return 'pytest';
  if (texts.some((text, at) => text === 'dotnet' && texts[at + 1] === 'test')) return 'dotnet';
  return undefined;
};

/** Whether `words` save a test report for `runner`, and whether they save coverage. */
const savesOf = (
  runner: TestRunner,
  words: readonly Word[],
): { report: boolean; coverage: boolean } => {
  const texts = words.map(({ text }) => text);
  const has = (test: (text: string) => boolean) => texts.some(test);
  switch (runner) {
    case 'node':
      return {
        report: has(
          (text) =>
            text.startsWith('--test-reporter-destination=') && !/=(?:stdout|stderr)$/.test(text),
        ),
        coverage: has((text) => text === '--experimental-test-coverage'),
      };
    case 'vitest':
      return {
        report: has((text) => text.startsWith('--outputFile')),
        coverage: has((text) => text === '--coverage' || text.startsWith('--coverage.')),
      };
    case 'pytest':
      return {
        report: has((text) => /^--junit-?xml(?:=|$)/.test(text)),
        coverage: has((text) => text === '--cov' || text.startsWith('--cov=')),
      };
    case 'dotnet':
      return {
        report:
          has((text) => /^--logger(?::|=|$)/.test(text) && /junit/i.test(text)) ||
          texts.some((text, at) => text === '--logger' && /^junit/i.test(texts[at + 1] ?? '')),
        coverage: has((text) => /XPlat Code Coverage/i.test(text)),
      };
    default: {
      const never: never = runner;
      throw new Error(`Unknown test runner ${String(never)}`);
    }
  }
};

/** What `line` saves, and what to add to it (ADR 0376). */
export const readTestLine = (line: string): TestLine => {
  const words = wordsOf(line);
  const runner = words === undefined ? undefined : runnerOf(words);
  if (words === undefined || runner === undefined) {
    return { runner: undefined, saves: false, advice: [] };
  }
  const saves = savesOf(runner, words);
  const coverage = runner === 'node' || saves.coverage ? [] : [COVERAGE[runner]];
  if (saves.report) return { runner, saves: true, advice: coverage };
  switch (runner) {
    case 'node': {
      // The flags go right after `--test`, before the files.
      const end = words.find(({ text }) => text === '--test')?.end ?? line.length;
      const withReport = `${line.slice(0, end)} ${NODE_REPORTS}${line.slice(end)}`;
      return { runner, saves: false, withReport, advice: [] };
    }
    case 'vitest':
      return { runner, saves: false, withReport: `${line} ${VITEST_REPORTS}`, advice: coverage };
    case 'pytest':
      return { runner, saves: false, withReport: `${line} ${PYTEST_REPORT}`, advice: coverage };
    case 'dotnet':
      // Its JUnit logger is a package, and Foedrum does not read TRX (ADR 0376).
      return { runner, saves: false, advice: [DOTNET_REPORT, ...coverage] };
    default: {
      const never: never = runner;
      throw new Error(`Unknown test runner ${String(never)}`);
    }
  }
};

/**
 * The test line `foedrum init` writes for a Node repository whose `test` script is `script`: the
 * script itself with node's flags, which `npm test --` would hand to the tests, `npm test` with
 * vitest's, and `npm test` for any other runner (ADR 0376).
 */
export const npmTestLine = (script: string): string => {
  const read = readTestLine(script);
  if (read.runner === 'node') return read.withReport ?? script;
  if (read.runner === 'vitest' && !read.saves) return `npm test -- ${VITEST_REPORTS}`;
  return 'npm test';
};

/** What `foedrum init` says of the test line it writes: what it could not set up (ADR 0376). */
export const testLineNotes = (line: string): string[] => {
  const read = readTestLine(line);
  return read.runner === undefined ? [UNKNOWN_RUNNER] : [...read.advice];
};
