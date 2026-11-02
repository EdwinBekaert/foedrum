// `node scripts/mutant-verdict.ts <baseline.jsonl> <run.jsonl> [<test file>...]`: says whether a
// mutant was killed, from the outcomes scripts/test-outcomes-reporter.ts wrote for a run without
// the mutant and a run with it (issue #43, ADR 0040). Given the test files the run ran, it reads
// only their outcomes in the baseline (ADR 0303). mutant-verdict/core.ts decides. Exits 1 when
// an outcome file cannot be read or the baseline has no passing test.

import { readFile } from 'node:fs/promises';
import { type Outcome, parseOutcomes, verdictOf } from './mutant-verdict/core.ts';

type Result = { ok: boolean; lines: string[] };

// The killers listed by name; the rest only counted.
const SHOWN = 5;

const read = async (path: string): Promise<Outcome[] | string> => {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    return `cannot read ${path}: ${(error as Error).message}`;
  }
  const outcomes = parseOutcomes(text);
  return typeof outcomes === 'string' ? `${path}: ${outcomes}` : outcomes;
};

export const mutantVerdict = async (
  baseline: string,
  run: string,
  files?: readonly string[],
): Promise<Result> => {
  const all = await read(baseline);
  if (typeof all === 'string') return { ok: false, lines: [all] };
  // A run over some of the baseline's test files is judged against their outcomes only.
  const before = files === undefined ? all : all.filter(({ file }) => files.includes(file));
  const after = await read(run);
  if (typeof after === 'string') return { ok: false, lines: [after] };
  const verdict = verdictOf(before, after);
  switch (verdict.kind) {
    case 'no baseline':
      return {
        ok: false,
        lines: ['the baseline has no passing test, so no mutant can be judged'],
      };
    case 'survived':
      return {
        ok: true,
        lines: [`survived: the ${verdict.passing} tests that pass without the mutant pass with it`],
      };
    case 'killed': {
      const { by } = verdict;
      // Quoted, so a line break in a test name (pull request text) cannot forge a line.
      const shown = by
        .slice(0, SHOWN)
        .map(({ file, test }) => `  ${JSON.stringify([file, ...test].join(' > '))}`);
      const more = by.length > SHOWN ? [`  … and ${by.length - SHOWN} more`] : [];
      return { ok: true, lines: [`killed by ${by.length} tests:`, ...shown, ...more] };
    }
    default: {
      const unexpected: never = verdict;
      throw new Error(`unexpected verdict ${JSON.stringify(unexpected)}`);
    }
  }
};

export interface MainResult {
  exitCode: number;
  stdout: string[];
  stderr: string[];
}

// The command line: its arguments, and what it prints and exits with.
export const main = async (argv: readonly string[]): Promise<MainResult> => {
  const [baseline, run, ...files] = argv;
  if (baseline === undefined || run === undefined) {
    const usage =
      'usage: node scripts/mutant-verdict.ts <baseline.jsonl> <run.jsonl> [<test file>...]';
    return { exitCode: 2, stdout: [], stderr: [usage] };
  }
  const { ok, lines } = await mutantVerdict(baseline, run, files.length > 0 ? files : undefined);
  return {
    exitCode: ok ? 0 : 1,
    stdout: lines.map((line) => `mutant-verdict: ${line}`),
    stderr: [],
  };
};

if (import.meta.main) {
  const { exitCode, stdout, stderr } = await main(process.argv.slice(2));
  for (const line of stdout) console.log(line);
  for (const line of stderr) console.error(line);
  process.exitCode = exitCode;
}
