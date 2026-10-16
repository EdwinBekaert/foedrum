import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type Outcome, parseOutcomes, verdictOf } from '../../scripts/mutant-verdict/core.ts';

const outcome = (name: string, ok: boolean, file = 'test/unit/a.test.ts'): Outcome => ({
  file,
  test: ['suite', name],
  ok,
});

// The baseline of the planted-defect sample on main: one unit test fails without any mutant.
const baseline = [outcome('a', true), outcome('b', true), outcome('starts git', false)];

describe('verdictOf', () => {
  it('lets a mutant survive when only tests that failed without it fail with it', () => {
    assert.deepEqual(verdictOf(baseline, baseline), { kind: 'survived', passing: 2 });
  });

  it('kills a mutant when a test that passed without it fails with it', () => {
    const run = [outcome('a', true), outcome('b', false), outcome('starts git', false)];
    assert.deepEqual(verdictOf(baseline, run), { kind: 'killed', by: [outcome('b', false)] });
  });

  it('kills a mutant when a passing test no longer reports, as when its file fails to load', () => {
    const loadFailure: Outcome = {
      file: 'test/unit/a.test.ts',
      test: ['test/unit/a.test.ts'],
      ok: false,
    };
    const verdict = verdictOf(baseline, [loadFailure]);
    assert.equal(verdict.kind, 'killed');
    assert.deepEqual(verdict.kind === 'killed' ? verdict.by : [], [
      outcome('a', false),
      outcome('b', false),
      loadFailure,
    ]);
  });

  it('kills a mutant when a failure appears that the baseline did not have', () => {
    const refused: Outcome = { file: 'test/unit/b.test.ts', test: ['after'], ok: false };
    assert.deepEqual(verdictOf(baseline, [...baseline, refused]), {
      kind: 'killed',
      by: [refused],
    });
  });

  it('does not count a test that only passes with the mutant', () => {
    const run = [outcome('a', true), outcome('b', true), outcome('starts git', true)];
    assert.deepEqual(verdictOf(baseline, run), { kind: 'survived', passing: 2 });
  });

  it('tells apart tests with the same name in different files, and repeated names', () => {
    const twice = [
      outcome('a', true),
      outcome('a', true),
      outcome('a', true, 'test/unit/b.test.ts'),
    ];
    assert.deepEqual(verdictOf(twice, twice), { kind: 'survived', passing: 3 });
    const run = [
      outcome('a', true),
      outcome('a', false),
      outcome('a', true, 'test/unit/b.test.ts'),
    ];
    assert.deepEqual(verdictOf(twice, run), { kind: 'killed', by: [outcome('a', false)] });
  });

  it('judges nothing when no test passed without the mutant', () => {
    assert.deepEqual(verdictOf([outcome('a', false)], []), { kind: 'no baseline' });
    assert.deepEqual(verdictOf([], []), { kind: 'no baseline' });
  });
});

describe('parseOutcomes', () => {
  it('reads one outcome per line, ignoring blank lines and CRLF', () => {
    const text = `${JSON.stringify(outcome('a', true))}\r\n\n${JSON.stringify(outcome('b', false))}\n`;
    assert.deepEqual(parseOutcomes(text), [outcome('a', true), outcome('b', false)]);
    assert.deepEqual(parseOutcomes(''), []);
  });

  it('says which line is not a test outcome', () => {
    const good = JSON.stringify(outcome('a', true));
    for (const bad of [
      'not json',
      '{"file":"a","test":["x"]}',
      '{"file":"a","test":"x","ok":true}',
      '{"file":"a","test":[1],"ok":true}',
      '{"file":3,"test":["x"],"ok":true}',
      'null',
    ]) {
      assert.equal(parseOutcomes(`${good}\n${bad}\n`), 'line 2 is not a test outcome', bad);
    }
  });
});
