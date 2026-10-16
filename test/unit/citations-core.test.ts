import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkLine, entriesOf, parseCitation } from '../../scripts/citations/core.ts';

const finding = { severity: 'major', file: 'src/engine/wait.ts', line: 13, title: 'No deadline' };

const reasonOf = (result: { ok: boolean; reason?: string }): string => {
  assert.equal(result.ok, false, 'expected the citation to be unverified');
  return result.reason ?? '';
};

describe('entriesOf', () => {
  it('takes the findings of a lens and the proposals of simplify', () => {
    assert.deepEqual(entriesOf({ lens: 'correctness', findings: [finding] }), [finding]);
    assert.deepEqual(entriesOf({ proposals: [finding, finding] }), [finding, finding]);
    assert.deepEqual(entriesOf({ verdict: 'approve', findings: [] }), []);
  });

  it('says so when the answer has neither list', () => {
    for (const answer of [null, 'text', [], { findings: 'none' }, {}]) {
      assert.equal(entriesOf(answer), 'the answer has no "findings" or "proposals" list');
    }
  });
});

describe('parseCitation', () => {
  it('takes the file and the line of a finding and drops the other fields', () => {
    assert.deepEqual(parseCitation(finding), {
      ok: true,
      citation: { file: 'src/engine/wait.ts', line: 13 },
    });
  });

  it('accepts a finding that cites no location at all', () => {
    for (const entry of [
      { title: 'two unrelated changes' },
      { file: null, line: null },
      { file: '' },
    ]) {
      assert.deepEqual(parseCitation(entry), { ok: true }, JSON.stringify(entry));
    }
  });

  it('rejects an entry that is not an object, or a file that is not a string', () => {
    assert.match(reasonOf(parseCitation('src/a.ts:3')), /not an object/);
    assert.match(reasonOf(parseCitation(null)), /not an object/);
    assert.match(reasonOf(parseCitation({ file: 3, line: 1 })), /"file" is not a string/);
  });

  it('rejects a line that is missing or not a line number', () => {
    for (const line of [undefined, null, 0, -1, 2.5, '13', Number.NaN]) {
      assert.match(
        reasonOf(parseCitation({ file: 'src/a.ts', line })),
        /"line" is not a line number/,
        String(line),
      );
    }
  });

  it('rejects a path that could leave the repository, quoting it whole', () => {
    for (const file of [
      '../secrets.txt',
      'src/../../x.ts',
      './src/a.ts',
      '/etc/passwd',
      'C:/x.ts',
      'src\\a.ts',
      'src//a.ts',
      'src/a.ts\nfinding 2: ok src/b.ts:1',
    ]) {
      const reason = reasonOf(parseCitation({ file, line: 1 }));
      assert.equal(reason, `${JSON.stringify(file)} is not a path in the repository`, file);
      assert.doesNotMatch(reason, /\n/);
    }
  });
});

describe('checkLine', () => {
  const citation = { file: 'src/engine/wait.ts', line: 3 };

  it('accepts a line within the file, the last one included', () => {
    assert.deepEqual(checkLine(citation, 'a\nb\nc\n'), { ok: true, citation });
    assert.deepEqual(checkLine(citation, 'a\r\nb\r\nc'), { ok: true, citation });
  });

  it('rejects a line past the end, not counting a final newline as a line', () => {
    assert.equal(reasonOf(checkLine(citation, 'a\nb\n')), 'src/engine/wait.ts has 2 lines, not 3');
    assert.equal(
      reasonOf(checkLine({ ...citation, line: 1 }, '')),
      'src/engine/wait.ts has 0 lines, not 1',
    );
  });

  it('rejects a file that does not exist', () => {
    assert.equal(reasonOf(checkLine(citation, undefined)), 'src/engine/wait.ts does not exist');
  });
});
