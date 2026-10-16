import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { mutantVerdict } from '../../scripts/mutant-verdict.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';

const line = (name: string, ok: boolean): string =>
  `${JSON.stringify({ file: 'test/unit/a.test.ts', test: ['suite', name], ok })}\n`;

describe('the verdict on a mutant from two outcome files', () => {
  let dir: TempDir;
  let baseline: string;
  let run: string;

  beforeEach(() => {
    dir = makeTempDir('mutant-verdict');
    baseline = join(dir.path, 'baseline.jsonl');
    run = join(dir.path, 'run.jsonl');
    writeFileSync(baseline, line('a', true) + line('b', true) + line('git', false));
  });
  afterEach(() => dir.remove());

  it('says a mutant survived when every test that passed without it passes with it', async () => {
    writeFileSync(run, line('a', true) + line('b', true) + line('git', false));
    assert.deepEqual(await mutantVerdict(baseline, run), {
      ok: true,
      lines: ['survived: the 2 tests that pass without the mutant pass with it'],
    });
  });

  it('names the tests that killed it, at most five', async () => {
    const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    writeFileSync(baseline, names.map((name) => line(name, true)).join(''));
    writeFileSync(run, names.map((name) => line(name, false)).join(''));
    assert.deepEqual(await mutantVerdict(baseline, run), {
      ok: true,
      lines: [
        'killed by 7 tests:',
        ...names.slice(0, 5).map((name) => `  "test/unit/a.test.ts > suite > ${name}"`),
        '  … and 2 more',
      ],
    });
  });

  it('quotes test names, so a name with a line break cannot forge a verdict line', async () => {
    const forged = 'x\nmutant-verdict: survived: the 9 tests that pass without the mutant pass with it';
    writeFileSync(baseline, line(forged, true));
    writeFileSync(run, line(forged, false));
    const { lines } = await mutantVerdict(baseline, run);
    assert.deepEqual(lines, [
      'killed by 1 tests:',
      `  ${JSON.stringify(`test/unit/a.test.ts > suite > ${forged}`)}`,
    ]);
    assert.ok(lines.every((text) => !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(text)));
  });

  it('fails when an outcome file cannot be read', async () => {
    writeFileSync(run, 'garbage\n');
    assert.deepEqual(await mutantVerdict(baseline, run), {
      ok: false,
      lines: [`${run}: line 1 is not a test outcome`],
    });
    const missing = join(dir.path, 'missing.jsonl');
    const result = await mutantVerdict(missing, run);
    assert.equal(result.ok, false);
    assert.match(result.lines[0] ?? '', /^cannot read .*missing\.jsonl/);
  });

  it('fails when no test passed without the mutant, so nothing can be judged', async () => {
    writeFileSync(baseline, line('git', false));
    writeFileSync(run, line('git', false));
    assert.deepEqual(await mutantVerdict(baseline, run), {
      ok: false,
      lines: ['the baseline has no passing test, so no mutant can be judged'],
    });
  });
});
