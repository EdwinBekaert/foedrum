import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type AdrFile, rebuild } from '../../scripts/adr-index/core.ts';

const INTRO = '# Architecture decision records\n\nWhat the records are.\n\n';
const TEMPLATE = '\n## Template\n\n```markdown\n# NNNN. Title\n```\n';
const HEADER = '| # | Decision | Status |\n|---|---|---|\n';

const readmeWith = (rows: string[]): string =>
  `${INTRO}${HEADER}${rows.map((row) => `${row}\n`).join('')}${TEMPLATE}`;

const record = (name: string, title: string, status: string): AdrFile => ({
  name,
  text: `# ${name.slice(0, 4)}. ${title}\n\nDate: 2026-10-01 · Status: ${status}\n\n## Context\nWhy.\n`,
});

const statusLine = (file: AdrFile): string => file.text.split('\n')[2] ?? '';

const built = (readme: string, records: AdrFile[]) => {
  const result = rebuild(readme, records);
  assert.ok(result.ok, result.ok ? '' : result.problems.join('\n'));
  return result;
};

const A = '0001-a.md';
const B = '0002-b.md';
const C = '0003-c.md';

describe('rebuilding the ADR index', () => {
  it('lists a record no one amends with its own title and status, and leaves it alone', () => {
    const readme = readmeWith(['| [0001](0001-a.md) | A first decision | Accepted |']);
    const result = built(readme, [record(A, 'A first decision', 'Accepted')]);
    assert.deepEqual(result, { ok: true, readme, records: [], changes: [] });
  });

  it('adds a missing row, in number order, and says which', () => {
    const result = built(readmeWith(['| [0002](0002-b.md) | Second | Proposed |']), [
      record(B, 'Second', 'Proposed'),
      record(A, 'First', 'Accepted'),
    ]);
    assert.equal(
      result.readme,
      readmeWith([
        '| [0001](0001-a.md) | First | Accepted |',
        '| [0002](0002-b.md) | Second | Proposed |',
      ]),
    );
    assert.deepEqual(result.changes, ['README.md: row 0001 added']);
  });

  it('writes both amending records into a record amended twice, and into its row', () => {
    const result = built(readmeWith([]), [
      record(A, 'First', 'Accepted'),
      record(B, 'Second', 'Accepted · Amends [0001](0001-a.md)'),
      record(C, 'Third', 'Accepted · Amends [0001](0001-a.md) (its second half)'),
    ]);
    assert.deepEqual(
      result.records.map((file) => [file.name, statusLine(file)]),
      [
        [
          A,
          'Date: 2026-10-01 · Status: Accepted · Amended by [0002](0002-b.md) and [0003](0003-c.md)',
        ],
      ],
    );
    assert.equal(
      result.readme,
      readmeWith([
        '| [0001](0001-a.md) | First | Accepted, amended by 0002 and 0003 |',
        '| [0002](0002-b.md) | Second (amends 0001) | Accepted |',
        '| [0003](0003-c.md) | Third (amends 0001) | Accepted |',
      ]),
    );
    assert.deepEqual(result.changes, [
      'README.md: row 0001 added',
      'README.md: row 0002 added',
      'README.md: row 0003 added',
      '0001-a.md:3: amended by 0002 and 0003 added',
    ]);
  });

  it('keeps every other byte of a status line: annotations, the old form, other parts, CRLF', () => {
    const old = record(
      A,
      'First',
      'Accepted, amended by [0003](0003-c.md) (the why) and [0004](0004-d.md) · Corrected 2026-10-02 (#9): a typo',
    );
    const crlf = { name: A, text: old.text.replaceAll('\n', '\r\n') };
    const result = built(readmeWith([]), [
      crlf,
      record(B, 'Second', 'Accepted · Amends [0001](0001-a.md) (one part)'),
      record(C, 'Third', 'Accepted · Amends [0001](0001-a.md)'),
      record('0004-d.md', 'Fourth', 'Accepted · Amends [0002](0002-b.md)'),
    ]);
    const [first] = result.records;
    assert.equal(
      first?.text,
      crlf.text.replace(
        '[0003](0003-c.md) (the why) and [0004](0004-d.md)',
        '[0002](0002-b.md) and [0003](0003-c.md) (the why)',
      ),
    );
    assert.ok(result.changes.includes('0001-a.md:3: amended by 0002 added, 0004 removed'));
  });

  it('credits a back link wherever its kind is named, and changes nothing when all are there', () => {
    const files = [
      record(
        A,
        'First',
        'Accepted · Amended by [0002](0002-b.md); its client superseded by [0003](0003-c.md)',
      ),
      record(B, 'Second', 'Accepted · Amends [0001](0001-a.md)'),
      record(C, 'Third', "Accepted · Supersedes [0001](0001-a.md)'s client"),
    ];
    const readme = readmeWith([
      '| [0001](0001-a.md) | First | Accepted, amended by 0002; partly superseded by 0003 |',
      '| [0002](0002-b.md) | Second (amends 0001) | Accepted |',
      '| [0003](0003-c.md) | Third (supersedes part of 0001) | Accepted |',
    ]);
    assert.deepEqual(built(readme, files), { ok: true, readme, records: [], changes: [] });
  });

  it('marks a superseded record as superseded, after its own status', () => {
    const result = built(readmeWith([]), [
      record(A, 'First', 'Accepted · Amends [0003](0003-c.md) · Corrected 2026-10-02: a typo'),
      record(B, 'Second', 'Accepted · Supersedes [0001](0001-a.md)'),
      record(C, 'Third', 'Superseded by [0004](0004-d.md)'),
      record('0004-d.md', 'Fourth', 'Accepted · Supersedes [0003](0003-c.md)'),
    ]);
    assert.deepEqual(
      result.records.map((file) => [file.name, statusLine(file)]),
      [
        [
          A,
          'Date: 2026-10-01 · Status: Accepted · Amends [0003](0003-c.md) · Superseded by [0002](0002-b.md) · Corrected 2026-10-02: a typo',
        ],
        [
          C,
          'Date: 2026-10-01 · Status: Superseded by [0004](0004-d.md) · Amended by [0001](0001-a.md)',
        ],
      ],
    );
    assert.match(
      result.readme,
      /\| \[0001\]\(0001-a\.md\) \| First \(amends 0003\) \| Accepted, superseded by 0002 \|/,
    );
    assert.match(
      result.readme,
      /\| \[0003\]\(0003-c\.md\) \| Third \| Superseded by 0004; amended by 0001 \|/,
    );
  });

  it('drops a back link that no record backs, with the clause when it was the only one', () => {
    const result = built(readmeWith([]), [
      record(
        A,
        'First',
        'Accepted, amended by [0002](0002-b.md) (no longer) · Amends [0003](0003-c.md)',
      ),
      record(B, 'Second', 'Accepted'),
      record(C, 'Third', 'Accepted · Amended by [0001](0001-a.md)'),
    ]);
    assert.deepEqual(
      result.records.map((file) => [file.name, statusLine(file)]),
      [[A, 'Date: 2026-10-01 · Status: Accepted · Amends [0003](0003-c.md)']],
    );
    assert.ok(result.changes.includes('0001-a.md:3: amended by 0002 removed'));
  });

  it('rewrites rows that are out of order or doubled, and says so', () => {
    const first = '| [0001](0001-a.md) | First | Accepted |';
    const second = '| [0002](0002-b.md) | Second | Accepted |';
    const files = [record(A, 'First', 'Accepted'), record(B, 'Second', 'Accepted')];
    for (const rows of [
      [second, first],
      [first, first, second],
    ]) {
      const result = built(readmeWith(rows), files);
      assert.deepEqual(
        { readme: result.readme, changes: result.changes },
        {
          readme: readmeWith([first, second]),
          changes: ['README.md: rows out of order or doubled'],
        },
      );
    }
  });

  it('reverses Generalises and Extends too, after what supersedes and amends', () => {
    const result = built(readmeWith([]), [
      record(A, 'First', 'Accepted'),
      record(B, 'Second', 'Accepted · Generalises [0001](0001-a.md)'),
      record(C, 'Third', 'Accepted · Extends [0001](0001-a.md)'),
      record('0004-d.md', 'Fourth', 'Accepted · Amends [0001](0001-a.md)'),
    ]);
    assert.deepEqual(
      result.records.map((file) => [file.name, statusLine(file)]),
      [
        [
          A,
          'Date: 2026-10-01 · Status: Accepted · Amended by [0004](0004-d.md) · Generalised by [0002](0002-b.md) · Extended by [0003](0003-c.md)',
        ],
      ],
    );
    assert.equal(
      result.readme,
      readmeWith([
        '| [0001](0001-a.md) | First | Accepted, amended by 0004; generalised by 0002; extended by 0003 |',
        '| [0002](0002-b.md) | Second (generalises 0001) | Accepted |',
        '| [0003](0003-c.md) | Third (extends 0001) | Accepted |',
        '| [0004](0004-d.md) | Fourth (amends 0001) | Accepted |',
      ]),
    );
  });

  it('takes no link or back phrase from inside parentheses', () => {
    const result = built(readmeWith([]), [
      record(
        A,
        'First',
        'Accepted (once amended by [0003](0003-c.md)) · Amended by [0002](0002-b.md)',
      ),
      record(B, 'Second', 'Accepted · Amends [0001](0001-a.md) (as [0003](0003-c.md) did)'),
      record(C, 'Third', 'Accepted'),
    ]);
    assert.deepEqual(result.records, []);
    assert.match(result.readme, /\| \[0003\]\(0003-c\.md\) \| Third \| Accepted \|/);
  });

  it('keeps a number once across two clauses of one kind, and the first takes the new ones', () => {
    const result = built(readmeWith([]), [
      record(
        A,
        'First',
        'Accepted, amended by [0002](0002-b.md) (first) · Amended by [0002](0002-b.md) and [0004](0004-d.md)',
      ),
      record(B, 'Second', 'Accepted · Amends [0001](0001-a.md)'),
      record(C, 'Third', 'Accepted · Amends [0001](0001-a.md)'),
      record('0004-d.md', 'Fourth', 'Accepted'),
    ]);
    assert.deepEqual(
      result.records.map((file) => [file.name, statusLine(file)]),
      [
        [
          A,
          'Date: 2026-10-01 · Status: Accepted, amended by [0002](0002-b.md) (first) and [0003](0003-c.md)',
        ],
      ],
    );
  });

  it('writes a partial supersede into the older record as partial', () => {
    const result = built(readmeWith([]), [
      record(A, 'First', 'Accepted · Amends [0002](0002-b.md)'),
      record(B, 'Second', 'Accepted'),
      record(C, 'Third', "Accepted · Supersedes [0001](0001-a.md)'s client and [0002](0002-b.md)"),
    ]);
    assert.deepEqual(
      result.records.map((file) => [file.name, statusLine(file)]),
      [
        [
          A,
          'Date: 2026-10-01 · Status: Accepted · Amends [0002](0002-b.md) · Partly superseded by [0003](0003-c.md)',
        ],
        [
          B,
          'Date: 2026-10-01 · Status: Accepted · Superseded by [0003](0003-c.md) · Amended by [0001](0001-a.md)',
        ],
      ],
    );
  });

  it('drops a back link named twice, and says so', () => {
    const result = built(readmeWith([]), [
      record(A, 'First', 'Accepted · Amended by [0002](0002-b.md) and [0002](0002-b.md)'),
      record(B, 'Second', 'Accepted · Amends [0001](0001-a.md)'),
    ]);
    assert.deepEqual(
      result.records.map((file) => [file.name, statusLine(file)]),
      [[A, 'Date: 2026-10-01 · Status: Accepted · Amended by [0002](0002-b.md)']],
    );
    assert.ok(result.changes.includes('0001-a.md:3: amended by 0002 named twice'));
  });

  it('fails on a back clause it cannot drop from the text around it', () => {
    const result = rebuild(readmeWith([]), [
      record(A, 'First', 'Accepted · Amended by [0002](0002-b.md) for now'),
      record(B, 'Second', 'Accepted'),
    ]);
    assert.deepEqual(result, {
      ok: false,
      problems: ['0001-a.md:3: cannot drop "Amended by [0002](0002-b.md)" from its text'],
    });
  });

  it('ignores other files, drops the row of a record that is gone, escapes pipes, keeps a BOM', () => {
    const bom = String.fromCodePoint(0xfeff);
    const first = record(A, 'First', 'Accepted');
    const result = built(readmeWith(['| [0009](0009-gone.md) | Gone | Accepted |']), [
      { name: A, text: `${bom}${first.text}` },
      record(B, 'Second | more', 'Accepted · Amends [0001](0001-a.md)'),
      { name: 'notes.txt', text: 'not a record' },
    ]);
    assert.deepEqual(
      result.records.map((file) => file.text.startsWith(`${bom}# 0001. First\n`)),
      [true],
    );
    assert.equal(
      result.readme,
      readmeWith([
        '| [0001](0001-a.md) | First | Accepted, amended by 0002 |',
        '| [0002](0002-b.md) | Second \\| more (amends 0001) | Accepted |',
      ]),
    );
    assert.ok(result.changes.includes('README.md: row 0009 removed'));
  });

  it('fails on a link to a number with no record, naming the file and line', () => {
    const result = rebuild(readmeWith([]), [
      record(A, 'First', 'Accepted'),
      record(B, 'Second', 'Accepted · Amends [0001](0001-a.md) and [0009](0009-gone.md)'),
    ]);
    assert.deepEqual(result, {
      ok: false,
      problems: ['0002-b.md:3: links to 0009, which has no record'],
    });
  });

  it('fails on two files with one number', () => {
    const result = rebuild(readmeWith([]), [
      record(A, 'First', 'Accepted'),
      record('0001-again.md', 'Again', 'Accepted'),
    ]);
    assert.deepEqual(result, {
      ok: false,
      problems: ['0001-a.md and 0001-again.md: two records numbered 0001'],
    });
  });

  it('fails on a first line or a status line it cannot read', () => {
    const result = rebuild(readmeWith([]), [
      { name: A, text: 'First\n\nDate: 2026-10-01 · Status: Accepted\n' },
      { name: B, text: '# 0002. Second\n\nDate: 2026-10-01\n' },
      { name: C, text: '# 0004. Third\n\nDate: 2026-10-01 · Status: Accepted\n' },
    ]);
    assert.deepEqual(result, {
      ok: false,
      problems: [
        '0001-a.md:1: the first line is not `# 0001. <title>`',
        '0002-b.md:3: no `Date: … · Status: …` line',
        '0003-c.md:1: the first line is not `# 0003. <title>`',
      ],
    });
  });

  it('fails when the README has no table before its template', () => {
    const result = rebuild(`${INTRO}${TEMPLATE}`, [record(A, 'First', 'Accepted')]);
    assert.deepEqual(result, {
      ok: false,
      problems: ['README.md: no `| # | Decision | Status |` table before `## Template`'],
    });
  });
});
