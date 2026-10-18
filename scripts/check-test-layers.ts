// Part of `npm run check`: fails when a file under test/unit/, test/property/, test/chaos/ or
// test/helpers/ imports node:child_process or the real process runner (spawnProcess or
// execProcess). npm test runs the first three and they import the helpers, so none of them may
// start a process (ADR 0021). Tests that run real tools belong in test/integration/. It also fails
// when a file under test/integration/ or test/helpers/ can start the real gh (ADR 0086, below).
// Exit 0: clean. Exit 1: one line per problem on stdout, with the line where there is one.
// It sees direct imports only: a test that starts a process through a module it imports is not
// caught here, but at run time: npm test's preload (scripts/refuse-process-starts.ts, ADR 0038)
// makes child_process's process starts throw in every test process and fails the file.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';

export interface LayerProblem {
  // Relative to the scanned directory, with forward slashes.
  file: string;
  // The line of the finding, from 1, when it is about one.
  line?: number;
  problem: string;
}

// Files in those folders that may import child_process or the real process runner anyway, by
// path relative to test/ with forward slashes, each with the reason. Empty by default: move a
// test that needs a real process to test/integration/ instead. An entry whose file imports
// neither is itself reported, so the list cannot go stale.
export const EXCEPTIONS: ReadonlyMap<string, string> = new Map([
  // ['unit/example.test.ts', 'why this test must start a process'],
]);

const SOURCE_FILE = /\.[cm]?[jt]s$/;
// `import … from`, `export … from`, `import '…'`, `import('…')` and `require('…')`, with or
// without the node: prefix. A string or comment that only names the module does not match; one
// that contains an import statement, and `import type`, do: the guard errs on the side of failing.
const CHILD_PROCESS_IMPORT = /\b(?:from|import|require)\s*\(?\s*(['"`])(?:node:)?child_process\1/;

// The real process runner (#12): spawnProcess, execProcess or streamProcess from src/platform/processes.ts or
// scripts/process-runner.ts, imported by name, as a namespace, re-exported, or through `import()`
// or `require()`, whose bindings it cannot see. `import type` and the runner with a fake spawner
// (execProcessWith, streamProcessWith) do not match.
const RUNNER_MODULE = String.raw`(?<quote>['"\`])[^'"\`\n]*(?:platform/processes|process-runner)(?:\.[cm]?[jt]s)?\k<quote>`;
const RUNNER_STATIC = new RegExp(
  String.raw`\b(?:import|export)\s+(?!type\b)(?<bindings>[^;]*?)\bfrom\s*${RUNNER_MODULE}`,
  'g',
);
const RUNNER_DYNAMIC = new RegExp(String.raw`\b(?:import|require)\s*\(\s*${RUNNER_MODULE}`);
const RUNNER_BINDING = /\*|(?<!\btype\s+)\b(?:spawnProcess|execProcess|streamProcess)\b/;

const importsRealRunner = (source: string): boolean =>
  RUNNER_DYNAMIC.test(source) ||
  [...source.matchAll(RUNNER_STATIC)].some(({ groups }) =>
    RUNNER_BINDING.test(groups?.bindings ?? ''),
  );

const IMPORTS =
  'imports child_process, but unit, property and chaos tests start no processes: move the test to test/integration/ (ADR 0021)';
const RUNNER =
  'imports the real process runner, but unit, property and chaos tests start no processes: inject a fake runner, or move the test to test/integration/ (ADR 0021)';
const STALE =
  'is on the exception list but does not import child_process or the real process runner: remove the entry from scripts/check-test-layers.ts';

// What source files under dir import that they may not, by file relative to dir with forward
// slashes.
const findingsIn = (dir: string): LayerProblem[] =>
  readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((path) => SOURCE_FILE.test(path))
    .flatMap((path) => {
      const source = readFileSync(join(dir, path), 'utf8');
      const file = path.split(sep).join('/');
      return [
        ...(CHILD_PROCESS_IMPORT.test(source) ? [{ file, problem: IMPORTS }] : []),
        ...(importsRealRunner(source) ? [{ file, problem: RUNNER }] : []),
      ];
    });

const problemsOf = (
  findings: LayerProblem[],
  exceptions: ReadonlyMap<string, string>,
): LayerProblem[] => {
  const problems = [
    ...findings.filter(({ file }) => !exceptions.has(file)),
    ...[...exceptions.keys()]
      .filter((file) => !findings.some((finding) => finding.file === file))
      .map((file) => ({ file, problem: STALE })),
  ];
  return problems.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
};

// One folder; files and exceptions are relative to it.
export const checkTestLayer = (
  dir: string,
  exceptions: ReadonlyMap<string, string>,
): LayerProblem[] => problemsOf(findingsIn(dir), exceptions);

// The folders under test/ that npm test runs or that those tests import (ADR 0021).
export const NO_PROCESS_FOLDERS = ['unit', 'property', 'chaos', 'helpers'] as const;

// Scans NO_PROCESS_FOLDERS under testDir, skipping one that does not exist; files and exceptions
// are relative to testDir.
export const checkTestLayers = (
  testDir: string,
  exceptions: ReadonlyMap<string, string>,
): LayerProblem[] =>
  problemsOf(
    NO_PROCESS_FOLDERS.filter((folder) => existsSync(join(testDir, folder))).flatMap((folder) =>
      findingsIn(join(testDir, folder)).map(({ file, problem }) => ({
        file: `${folder}/${file}`,
        problem,
      })),
    ),
    exceptions,
  );

// An integration test, or a helper it imports, may not start the real gh, which answers with
// whatever login the machine has (ADR 0086): no spawn of gh without a configuration of its own,
// no doctorFromCheckout, serveFromCheckout or cliFromCheckout without an injected runner, and no
// src/cli/main.ts run as a program, which wires in the real runner. Like the import check, it
// reads the text and errs on the side of failing; a helper of the test's own that wraps those
// calls is not followed.

// Integration tests and their helpers that may start the real gh anyway, by path relative to test/
// with forward slashes, each with the reason. An entry whose file has no finding is reported.
export const REAL_GH_EXCEPTIONS: ReadonlyMap<string, string> = new Map([
  [
    'integration/serve.test.ts',
    'the opt-in end-to-end serve test (FOEDRUM_REAL_CLAUDE=1, ADR 0057) runs src/cli/main.ts as the real program, whose gh reaches the local fake GitHub with a login of the test’s own (ADR 0073)',
  ],
]);

// The folders under test/ whose files integration tests run or import.
export const REAL_GH_FOLDERS = ['integration', 'helpers'] as const;

export interface RealGhFinding {
  line: number;
  problem: string;
}

interface Literal {
  start: number;
  value: string;
}

// The source with comments and the contents of strings, templates and regular expressions blanked
// (newlines and the quotes themselves kept, so offsets and lines stay), and its string literals.
// A template's `${…}` stays code.
const scan = (source: string): { code: string; literals: Literal[] } => {
  const code = source.split('');
  const literals: Literal[] = [];
  const blank = (from: number, to: number) => {
    for (let i = from; i < to; i++) if (code[i] !== '\n') code[i] = ' ';
  };
  // Brace depths of the `${…}` the scan is in, innermost last.
  const templates: number[] = [];
  let depth = 0;
  // The last character of code that is not blank: a `/` after it starts a regular expression.
  let previous = '';
  let i = 0;
  // From the quote at `from`, or inside a template, to the end of the string or `${`.
  const stringFrom = (from: number, quote: string): number => {
    let j = from + 1;
    while (j < source.length && source[j] !== quote) {
      if (quote === '`' && source.startsWith('${', j)) break;
      if (quote !== '`' && source[j] === '\n') break;
      j += source[j] === '\\' ? 2 : 1;
    }
    literals.push({ start: from, value: source.slice(from + 1, j) });
    blank(from + 1, j);
    return j;
  };
  while (i < source.length) {
    const char = source[i] ?? '';
    if (source.startsWith('//', i)) {
      const end = source.indexOf('\n', i);
      const to = end === -1 ? source.length : end;
      blank(i, to);
      i = to;
    } else if (source.startsWith('/*', i)) {
      const end = source.indexOf('*/', i + 2);
      const to = end === -1 ? source.length : end + 2;
      blank(i, to);
      i = to;
    } else if (char === "'" || char === '"' || char === '`') {
      i = stringFrom(i, char);
      if (source.startsWith('${', i)) {
        templates.push(depth);
        i += 2;
      } else i += 1;
      previous = char;
    } else if (char === '}' && templates.length > 0 && templates.at(-1) === depth) {
      templates.pop();
      i = stringFrom(i, '`');
      if (source.startsWith('${', i)) {
        templates.push(depth);
        i += 2;
      } else i += 1;
      previous = '`';
    } else if (char === '/' && (previous === '' || /[(,=:[!&|?{};+\-*%<>~^]/.test(previous))) {
      let j = i + 1;
      let inClass = false;
      while (j < source.length && source[j] !== '\n' && (inClass || source[j] !== '/')) {
        if (source[j] === '[') inClass = true;
        else if (source[j] === ']') inClass = false;
        j += source[j] === '\\' ? 2 : 1;
      }
      blank(i + 1, j);
      i = j + 1;
      previous = '/';
    } else {
      if (char === '{') depth++;
      else if (char === '}') depth--;
      if (!/\s/.test(char)) previous = char;
      i += 1;
    }
  }
  return { code: code.join(''), literals };
};

// The offset of the parenthesis that closes the one at `open`, in code whose strings are blank.
const closing = (code: string, open: number): number => {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === '(') depth++;
    else if (code[i] === ')' && --depth === 0) return i;
  }
  return code.length;
};

const SPAWNERS = new Set([
  'spawn',
  'spawnSync',
  'exec',
  'execSync',
  'execFile',
  'execFileSync',
  'execProcess',
  'spawnProcess',
  'streamProcess',
]);
const CALL = /\b(?<callee>[A-Za-z_$][\w$]*)\s*\(\s*(?=['"`])/g;
const GH_PROGRAM = /^gh(?:\.exe|\.cmd)?$/i;
const FROM_CHECKOUT = /\b(?<name>doctorFromCheckout|serveFromCheckout|cliFromCheckout)\s*\(/g;
// `exec` as a key or a shorthand property of an options object.
const INJECTED_RUNNER = /[{,]\s*exec\s*[:,}]/;
const MAIN_PROGRAM = /^(?:main\.ts|(?:.*[/\\])?cli[/\\]main\.ts)$/;

const GH_SPAWN =
  'starts gh, which answers with whatever login the machine has: give the call a configuration of the test’s own (GH_CONFIG_DIR in its env, as fake-github-over-gh.ts does), or answer gh from captured output (canned-gh-login.ts, ADR 0086)';
const NO_RUNNER = (name: string) =>
  `calls ${name} without an injected runner, so it can start the real gh: pass { exec, resolve }, such as cannedGhLogin() and resolveWithMadeUpGh (ADR 0086)`;
const MAIN =
  'runs src/cli/main.ts, the real program, whose real runner can start the real gh: call cliFromCheckout with an injected runner instead (ADR 0086)';
const STALE_GH =
  'is on the real gh exception list but nothing in it can start the real gh: remove the entry from scripts/check-test-layers.ts';

// What in one source file can start the real gh, by line.
export const realGhFindings = (source: string): RealGhFinding[] => {
  const { code, literals } = scan(source);
  const lineAt = (offset: number) => source.slice(0, offset).split('\n').length;
  const literalAt = new Map(literals.map((literal) => [literal.start, literal.value]));
  const found: { offset: number; problem: string }[] = [];
  for (const match of code.matchAll(CALL)) {
    const quote = match.index + match[0].length;
    const value = literalAt.get(quote) ?? '';
    const callee = match.groups?.callee ?? '';
    const afterLiteral = code.slice(quote + value.length + 2);
    const spawn =
      (GH_PROGRAM.test(value) && (SPAWNERS.has(callee) || /^\s*,\s*\[/.test(afterLiteral))) ||
      (/^gh\s/i.test(value) && SPAWNERS.has(callee));
    const open = code.indexOf('(', match.index);
    if (spawn && !/\bGH_CONFIG_DIR\b/.test(code.slice(open, closing(code, open)))) {
      found.push({ offset: match.index, problem: GH_SPAWN });
    }
  }
  for (const match of code.matchAll(FROM_CHECKOUT)) {
    const open = match.index + match[0].length - 1;
    if (!INJECTED_RUNNER.test(code.slice(open, closing(code, open)))) {
      found.push({ offset: match.index, problem: NO_RUNNER(match.groups?.name ?? '') });
    }
  }
  for (const { start, value } of literals) {
    if (MAIN_PROGRAM.test(value)) found.push({ offset: start, problem: MAIN });
  }
  return found
    .sort((a, b) => a.offset - b.offset)
    .map(({ offset, problem }) => ({ line: lineAt(offset), problem }));
};

const byFileAndLine = (a: LayerProblem, b: LayerProblem): number =>
  a.file < b.file ? -1 : a.file > b.file ? 1 : (a.line ?? 0) - (b.line ?? 0);

// The findings of the sources, by file relative to test/, and the stale exceptions.
export const realGhProblems = (
  sources: ReadonlyMap<string, string>,
  exceptions: ReadonlyMap<string, string>,
): LayerProblem[] => {
  const findings = [...sources].flatMap(([file, source]) =>
    realGhFindings(source).map(({ line, problem }) => ({ file, line, problem })),
  );
  return [
    ...findings.filter(({ file }) => !exceptions.has(file)),
    ...[...exceptions.keys()]
      .filter((file) => !findings.some((finding) => finding.file === file))
      .map((file) => ({ file, problem: STALE_GH })),
  ].sort(byFileAndLine);
};

// Scans REAL_GH_FOLDERS under testDir, skipping one that does not exist; files and exceptions are
// relative to testDir.
export const checkRealGh = (
  testDir: string,
  exceptions: ReadonlyMap<string, string>,
): LayerProblem[] =>
  realGhProblems(
    new Map(
      REAL_GH_FOLDERS.filter((folder) => existsSync(join(testDir, folder))).flatMap((folder) =>
        readdirSync(join(testDir, folder), { recursive: true, encoding: 'utf8' })
          .filter((path) => SOURCE_FILE.test(path))
          .map((path): [string, string] => [
            `${folder}/${path.split(sep).join('/')}`,
            readFileSync(join(testDir, folder, path), 'utf8'),
          ]),
      ),
    ),
    exceptions,
  );

if (import.meta.main) {
  const testDir = join(import.meta.dirname, '..', 'test');
  const problems = [
    ...checkTestLayers(testDir, EXCEPTIONS),
    ...checkRealGh(testDir, REAL_GH_EXCEPTIONS),
  ];
  for (const { file, line, problem } of problems) {
    process.stdout.write(`test/${file}${line === undefined ? '' : `:${line}`} ${problem}\n`);
  }
  process.exitCode = problems.length > 0 ? 1 : 0;
}
