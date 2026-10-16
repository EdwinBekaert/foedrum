// Decides whether a mutant was killed, from the test outcomes of a run without it (the baseline)
// and a run with it (issue #43, ADR 0040). Only a test that fails because of the mutant kills it: a test
// that passed in the baseline and fails or no longer reports, or a failure the baseline did not
// have. A test that fails in both runs, the per-file time budget and the coverage thresholds do
// not count.

export interface Outcome {
  file: string;
  test: string[];
  ok: boolean;
}

export type Verdict =
  | { kind: 'killed'; by: Outcome[] }
  | { kind: 'survived'; passing: number }
  | { kind: 'no baseline' };

const isOutcome = (value: unknown): value is Outcome => {
  if (typeof value !== 'object' || value === null) return false;
  const { file, test, ok } = value as Record<string, unknown>;
  return (
    typeof file === 'string' &&
    Array.isArray(test) &&
    test.every((name) => typeof name === 'string') &&
    typeof ok === 'boolean'
  );
};

// The outcomes in the reporter's output, one JSON line each, or why they cannot be read.
export const parseOutcomes = (text: string): Outcome[] | string => {
  const outcomes: Outcome[] = [];
  for (const [index, line] of text.split('\n').entries()) {
    if (line.trim() === '') continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      value = undefined;
    }
    if (!isOutcome(value)) return `line ${index + 1} is not a test outcome`;
    outcomes.push({ file: value.file, test: value.test, ok: value.ok });
  }
  return outcomes;
};

const keyOf = ({ file, test }: Outcome): string => JSON.stringify([file, ...test]);

// How many times each test passed and failed, by key; a name can repeat within a suite.
const tally = (outcomes: Outcome[]) => {
  const counts = new Map<string, { outcome: Outcome; passed: number; failed: number }>();
  for (const outcome of outcomes) {
    const count = counts.get(keyOf(outcome)) ?? { outcome, passed: 0, failed: 0 };
    if (outcome.ok) count.passed += 1;
    else count.failed += 1;
    counts.set(keyOf(outcome), count);
  }
  return counts;
};

export const verdictOf = (baseline: Outcome[], run: Outcome[]): Verdict => {
  const passing = baseline.filter(({ ok }) => ok).length;
  if (passing === 0) return { kind: 'no baseline' };
  const before = tally(baseline);
  const after = tally(run);
  const by: Outcome[] = [];
  for (const [key, { outcome, passed }] of before) {
    if ((after.get(key)?.passed ?? 0) < passed) by.push({ ...outcome, ok: false });
  }
  for (const [key, { outcome, failed }] of after) {
    const known = by.some((killer) => keyOf(killer) === key);
    if (!known && failed > (before.get(key)?.failed ?? 0)) by.push({ ...outcome, ok: false });
  }
  return by.length > 0 ? { kind: 'killed', by } : { kind: 'survived', passing };
};
