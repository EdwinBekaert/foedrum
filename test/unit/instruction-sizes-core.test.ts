import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { compare, formatReport, isAudited, measure } from '../../scripts/instruction-sizes/core.ts';

describe('isAudited', () => {
  it('takes CLAUDE.md, the skills, the agents and the defaults', () => {
    for (const path of [
      'CLAUDE.md',
      '.claude/skills/brew-review/SKILL.md',
      '.claude/skills/brew-review/lenses/simplify.md',
      '.claude/agents/brett.md',
      'defaults/lenses/security.md',
      'defaults/recipes/nip.jsonc',
    ]) {
      assert.equal(isAudited(path), true, path);
    }
  });

  it('leaves out everything else, scaffolding and look-alike names included', () => {
    for (const path of [
      '.claude/settings.json',
      'docs/CLAUDE.md',
      'CLAUDE.md.bak',
      '.claude/skillsx/a.md',
      'defaultsx/a.md',
      'defaults/.gitkeep',
      'src/defaults/a.md',
    ]) {
      assert.equal(isAudited(path), false, path);
    }
  });
});

describe('measure', () => {
  it('counts an empty file as no bytes and no lines', () => {
    assert.deepEqual(measure(''), { bytes: 0, lines: 0 });
  });

  it('counts a last line without a newline', () => {
    assert.deepEqual(measure('a\nb'), { bytes: 3, lines: 2 });
    assert.deepEqual(measure('a\nb\n'), { bytes: 4, lines: 2 });
  });

  it('counts a CRLF line once and every byte of it', () => {
    assert.deepEqual(measure('a\r\nb\r\n'), { bytes: 6, lines: 2 });
  });

  it('counts bytes in UTF-8, a byte order mark included', () => {
    const byteOrderMark = String.fromCodePoint(0xfeff);
    assert.deepEqual(measure(`${byteOrderMark}é\n`), { bytes: 6, lines: 1 });
  });
});

describe('compare', () => {
  it('lists the files in path order with their size now', () => {
    const rows = compare({
      'defaults/b.md': { bytes: 2, lines: 1 },
      'CLAUDE.md': { bytes: 9, lines: 3 },
    });
    assert.deepEqual(rows, [
      { file: 'CLAUDE.md', now: { bytes: 9, lines: 3 } },
      { file: 'defaults/b.md', now: { bytes: 2, lines: 1 } },
    ]);
  });

  it('pairs each file with its size before, and keeps new and removed files', () => {
    const rows = compare(
      { 'CLAUDE.md': { bytes: 9, lines: 3 }, 'defaults/new.md': { bytes: 1, lines: 1 } },
      { 'CLAUDE.md': { bytes: 5, lines: 2 }, 'defaults/old.md': { bytes: 4, lines: 2 } },
    );
    assert.deepEqual(rows, [
      { file: 'CLAUDE.md', now: { bytes: 9, lines: 3 }, before: { bytes: 5, lines: 2 } },
      { file: 'defaults/new.md', now: { bytes: 1, lines: 1 } },
      { file: 'defaults/old.md', before: { bytes: 4, lines: 2 } },
    ]);
  });
});

describe('formatReport', () => {
  it('prints bytes and lines per file and the total, tab-separated', () => {
    const rows = [
      { file: 'CLAUDE.md', now: { bytes: 9, lines: 3 } },
      { file: 'defaults/b.md', now: { bytes: 2, lines: 1 } },
    ];
    assert.deepEqual(formatReport(rows), [
      'file\tbytes\tlines',
      'CLAUDE.md\t9\t3',
      'defaults/b.md\t2\t1',
      'total\t11\t4',
    ]);
  });

  it('adds the change since the earlier commit, for new and removed files too', () => {
    const rows = [
      { file: 'CLAUDE.md', now: { bytes: 9, lines: 3 }, before: { bytes: 5, lines: 3 } },
      { file: 'defaults/a.md', now: { bytes: 4, lines: 1 }, before: { bytes: 6, lines: 2 } },
      { file: 'defaults/new.md', now: { bytes: 1, lines: 1 } },
      { file: 'defaults/old.md', before: { bytes: 4, lines: 2 } },
    ];
    assert.deepEqual(formatReport(rows, 'abc1234'), [
      'file\tbytes\tlines\tbytes since abc1234\tlines since abc1234',
      'CLAUDE.md\t9\t3\t+4\t0',
      'defaults/a.md\t4\t1\t-2\t-1',
      'defaults/new.md\t1\t1\tnew\tnew',
      'defaults/old.md\t-\t-\t-4\t-2',
      'total\t14\t5\t-1\t-2',
    ]);
  });

  it('says when CLAUDE.md passes the memory docs target of 200 lines', () => {
    const report = formatReport([{ file: 'CLAUDE.md', now: { bytes: 900, lines: 201 } }]);
    assert.equal(report.at(-1), 'CLAUDE.md: 201 lines, over the memory docs target of 200');
    const atTarget = formatReport([{ file: 'CLAUDE.md', now: { bytes: 900, lines: 200 } }]);
    assert.equal(atTarget.at(-1), 'total\t900\t200');
  });
});
