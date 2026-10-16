import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { type OutcomeEvent, outcomesReporter } from '../../scripts/test-outcomes-reporter.ts';

const cwd = join(import.meta.dirname, 'repo');
const fileA = join(cwd, 'test', 'unit', 'a.test.ts');
const fileB = join(cwd, 'test', 'unit', 'b.test.ts');

const start = (file: string, nesting: number, name: string): OutcomeEvent => ({
  type: 'test:start',
  data: { file, nesting, name },
});
const end = (
  ok: boolean,
  file: string,
  nesting: number,
  name: string,
  extra: Partial<NonNullable<OutcomeEvent['data']>> = {},
): OutcomeEvent => ({
  type: ok ? 'test:pass' : 'test:fail',
  data: { file, nesting, name, details: { type: 'test' }, ...extra },
});

const report = async (events: OutcomeEvent[]): Promise<unknown[]> => {
  const source = (async function* () {
    yield* events;
  })();
  const lines: string[] = [];
  for await (const line of outcomesReporter({ cwd })(source)) lines.push(line);
  assert.ok(
    lines.every((line) => line.endsWith('\n')),
    'one line per outcome',
  );
  return lines.map((line) => JSON.parse(line));
};

describe('outcomesReporter', () => {
  it('writes each test with its file, its suites and whether it passed', async () => {
    const outcomes = await report([
      start(fileA, 0, 'suite'),
      start(fileA, 1, 'inner'),
      start(fileA, 2, 'passes'),
      end(true, fileA, 2, 'passes'),
      start(fileA, 2, 'fails'),
      end(false, fileA, 2, 'fails'),
      end(false, fileA, 1, 'inner', { details: { type: 'suite' } }),
      start(fileA, 1, 'next'),
      end(true, fileA, 1, 'next'),
      end(false, fileA, 0, 'suite', { details: { type: 'suite' } }),
      start(fileB, 0, 'top level'),
      end(true, fileB, 0, 'top level'),
    ]);
    assert.deepEqual(outcomes, [
      { file: 'test/unit/a.test.ts', test: ['suite', 'inner', 'passes'], ok: true },
      { file: 'test/unit/a.test.ts', test: ['suite', 'inner', 'fails'], ok: false },
      { file: 'test/unit/a.test.ts', test: ['suite', 'next'], ok: true },
      { file: 'test/unit/b.test.ts', test: ['top level'], ok: true },
    ]);
  });

  it('keeps the suites of each file apart when the events of two files interleave', async () => {
    const outcomes = await report([
      start(fileA, 0, 'suite a'),
      start(fileB, 0, 'suite b'),
      start(fileB, 1, 'in b'),
      start(fileA, 1, 'in a'),
      end(true, fileA, 1, 'in a'),
      end(true, fileB, 1, 'in b'),
    ]);
    assert.deepEqual(outcomes, [
      { file: 'test/unit/a.test.ts', test: ['suite a', 'in a'], ok: true },
      { file: 'test/unit/b.test.ts', test: ['suite b', 'in b'], ok: true },
    ]);
  });

  it('writes a suite that failed on its own, as when a hook throws, but not one whose tests failed', async () => {
    const outcomes = await report([
      start(fileA, 0, 'cleanup'),
      start(fileA, 1, 'passes'),
      end(true, fileA, 1, 'passes'),
      end(false, fileA, 0, 'cleanup', {
        details: { type: 'suite', error: { failureType: 'hookFailed' } },
      }),
      start(fileB, 0, 'parent'),
      start(fileB, 1, 'fails'),
      end(false, fileB, 1, 'fails'),
      end(false, fileB, 0, 'parent', {
        details: { type: 'suite', error: { failureType: 'subtestsFailed' } },
      }),
    ]);
    assert.deepEqual(outcomes, [
      { file: 'test/unit/a.test.ts', test: ['cleanup', 'passes'], ok: true },
      { file: 'test/unit/a.test.ts', test: ['cleanup'], ok: false },
      { file: 'test/unit/b.test.ts', test: ['parent', 'fails'], ok: false },
    ]);
  });

  it('writes a file that failed to load as a failed test named after the file', async () => {
    const name = join('test', 'unit', 'b.test.ts');
    assert.deepEqual(await report([start(fileB, 0, name), end(false, fileB, 0, name)]), [
      { file: 'test/unit/b.test.ts', test: [name], ok: false },
    ]);
  });

  it('leaves out skipped and todo tests and events of other kinds', async () => {
    const outcomes = await report([
      start(fileA, 0, 'skipped'),
      end(true, fileA, 0, 'skipped', { skip: true }),
      start(fileA, 0, 'todo'),
      end(false, fileA, 0, 'todo', { todo: 'later' }),
      { type: 'test:diagnostic', data: { file: fileA, nesting: 0, message: 'tests 2' } },
      { type: 'test:summary', data: { file: fileA, duration_ms: 3 } },
    ]);
    assert.deepEqual(outcomes, []);
  });
});
