// `node scripts/mutant-verdict.ts <baseline.jsonl> <run.jsonl>`: says whether a mutant was
// killed, from the outcomes scripts/test-outcomes-reporter.ts wrote for a run without the mutant
// and a run with it (issue #43). mutant-verdict/core.ts decides. Exits 1 when an outcome file
// cannot be read or the baseline has no passing test.

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

export const mutantVerdict = async (baseline: string, run: string): Promise<Result> => {
  const before = await read(baseline);
  if (typeof before === 'string') return { ok: false, lines: [before] };
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
      const shown = by.slice(0, SHOWN).map(({ file, test }) => `  ${[file, ...test].join(' > ')}`);
      const more = by.length > SHOWN ? [`  … and ${by.length - SHOWN} more`] : [];
      return { ok: true, lines: [`killed by ${by.length} tests:`, ...shown, ...more] };
    }
    default: {
      const unexpected: never = verdict;
      throw new Error(`unexpected verdict ${JSON.stringify(unexpected)}`);
    }
  }
};

if (import.meta.main) {
  const [baseline, run] = process.argv.slice(2);
  if (baseline === undefined || run === undefined) {
    console.error('usage: node scripts/mutant-verdict.ts <baseline.jsonl> <run.jsonl>');
    process.exitCode = 2;
  } else {
    const { ok, lines } = await mutantVerdict(baseline, run);
    for (const line of lines) console.log(`mutant-verdict: ${line}`);
    if (!ok) process.exitCode = 1;
  }
}
