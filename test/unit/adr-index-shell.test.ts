import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { run } from '../../scripts/adr-index.ts';

const README =
  '# Records\n\n| # | Decision | Status |\n|---|---|---|\n| [0001](0001-a.md) | First | Accepted |\n\n## Template\n';
const FIRST = '# 0001. First\n\nDate: 2026-10-01 · Status: Accepted\n';
const SECOND = '# 0002. Second\n\nDate: 2026-10-01 · Status: Accepted · Amends [0001](0001-a.md)\n';

const runWith = (args: string[], files: Record<string, string>) => {
  const folder = { ...files };
  const out: string[] = [];
  const err: string[] = [];
  const written: string[] = [];
  const code = run(args, {
    list: () => Object.keys(folder),
    readFile: (name) => {
      const text = folder[name];
      if (text === undefined) throw new Error(`ENOENT: ${name}`);
      return text;
    },
    writeFile: (name, text) => {
      written.push(name);
      folder[name] = text;
    },
    out: (text) => out.push(text),
    err: (text) => err.push(text),
  });
  return { code, out: out.join(''), err: err.join(''), written, folder };
};

describe('node scripts/adr-index.ts', () => {
  it('writes the rebuilt table and status lines and names each change', () => {
    const result = runWith([], { 'README.md': README, '0001-a.md': FIRST, '0002-b.md': SECOND });
    assert.equal(result.code, 0);
    assert.deepEqual(result.written.sort(), ['0001-a.md', 'README.md']);
    assert.equal(
      result.folder['0001-a.md'],
      '# 0001. First\n\nDate: 2026-10-01 · Status: Accepted · Amended by [0002](0002-b.md)\n',
    );
    assert.match(
      result.folder['README.md'] ?? '',
      /\| \[0002\]\(0002-b\.md\) \| Second \(amends 0001\) \| Accepted \|/,
    );
    assert.equal(
      result.out,
      'docs/adr/README.md: row 0001 changed\ndocs/adr/README.md: row 0002 added\ndocs/adr/0001-a.md:3: amended by 0002 added\n',
    );
  });

  it('with --check writes nothing and exits 1 naming what differs', () => {
    const result = runWith(['--check'], {
      'README.md': README,
      '0001-a.md': FIRST,
      '0002-b.md': SECOND,
    });
    assert.deepEqual({ code: result.code, written: result.written }, { code: 1, written: [] });
    assert.match(result.out, /^docs\/adr\/0001-a\.md:3: amended by 0002 added$/m);
  });

  it('with --check exits 1 on a single difference', () => {
    const result = runWith(['--check'], {
      'README.md': README.replace('| First | Accepted |', '| First | Proposed |'),
      '0001-a.md': FIRST,
    });
    assert.deepEqual(
      { code: result.code, out: result.out },
      { code: 1, out: 'docs/adr/README.md: row 0001 changed\n' },
    );
  });

  it('with --check exits 0 and prints nothing when the index is up to date', () => {
    const result = runWith(['--check'], { 'README.md': README, '0001-a.md': FIRST });
    assert.deepEqual(
      { code: result.code, out: result.out, err: result.err, written: result.written },
      { code: 0, out: '', err: '', written: [] },
    );
  });

  it('prints each problem and writes nothing when the records cannot be read', () => {
    const result = runWith([], {
      'README.md': README,
      '0001-a.md': FIRST,
      '0002-b.md': '# 0002. Second\n',
    });
    assert.deepEqual(
      { code: result.code, err: result.err, written: result.written },
      { code: 1, err: 'docs/adr/0002-b.md:3: no `Date: … · Status: …` line\n', written: [] },
    );
  });

  it('leaves the README alone when only a status line changes', () => {
    const current =
      '# Records\n\n| # | Decision | Status |\n|---|---|---|\n| [0001](0001-a.md) | First | Accepted, amended by 0002 |\n| [0002](0002-b.md) | Second (amends 0001) | Accepted |\n\n## Template\n';
    const result = runWith([], { 'README.md': current, '0001-a.md': FIRST, '0002-b.md': SECOND });
    assert.deepEqual(
      { code: result.code, written: result.written },
      { code: 0, written: ['0001-a.md'] },
    );
  });

  it('reads only the README and the record files, never a folder or another file', () => {
    const reads: string[] = [];
    const code = run(['--check'], {
      list: () => ['README.md', 'images', 'notes.txt', '0001-a.md'],
      readFile: (name) => {
        reads.push(name);
        if (name === 'README.md') return README;
        if (name === '0001-a.md') return FIRST;
        return ''; // a folder would throw EISDIR here
      },
      writeFile: () => assert.fail('nothing to write'),
      out: () => {},
      err: () => {},
    });
    assert.deepEqual({ code, reads: reads.sort() }, { code: 0, reads: ['0001-a.md', 'README.md'] });
  });

  it('exits 2 on an argument it does not know', () => {
    const result = runWith(['--write'], { 'README.md': README });
    assert.deepEqual(
      { code: result.code, err: result.err },
      { code: 2, err: 'usage: node scripts/adr-index.ts [--check]\n' },
    );
  });
});
