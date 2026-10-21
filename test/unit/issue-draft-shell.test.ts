import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { run } from '../../scripts/issue-draft.ts';

const runWith = (args: string[], files: Record<string, string>) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(args, {
    readFile: (file) => {
      const text = files[file];
      if (text === undefined) throw new Error(`ENOENT: no such file, open '${file}'`);
      return text;
    },
    out: (text) => out.push(text),
    err: (text) => err.push(text),
  });
  return { code, out: out.join(''), err: err.join('') };
};

describe('node scripts/issue-draft.ts <draft.json>', () => {
  it('prints the title and exits 0 for a draft that can be filed', () => {
    const files = { 'd/1.json': JSON.stringify({ title: 'A stale lease', body: 'b' }) };
    assert.deepEqual(runWith(['d/1.json'], files), { code: 0, out: 'A stale lease\n', err: '' });
  });

  it('prints one line per problem and exits 1 for a draft it refuses', () => {
    const files = { 'd/1.json': JSON.stringify({ title: '', body: 'b', labels: [] }) };
    assert.deepEqual(runWith(['d/1.json'], files), {
      code: 1,
      out: 'unexpected key "labels"\n"title" is empty\n',
      err: '',
    });
  });

  it('refuses a draft it cannot read with one line, and exits 1', () => {
    const result = runWith(['d/missing.json'], {});
    assert.equal(result.code, 1);
    assert.match(result.out, /^cannot read the draft: ENOENT[^\n]*\n$/);
  });

  it('escapes control and format characters in a read error, such as those of the path', () => {
    const rightToLeft = String.fromCodePoint(0x202e);
    const out: string[] = [];
    const code = run(['d/1.json'], {
      readFile: () => {
        throw new Error(`ENOENT: open 'd/x\u001b[2J${rightToLeft}\r.json'`);
      },
      out: (text) => out.push(text),
      err: () => {},
    });
    assert.deepEqual(
      { code, out: out.join('') },
      { code: 1, out: "cannot read the draft: ENOENT: open 'd/x\\u001b[2J\\u202e\\u000d.json'\n" },
    );
  });

  it('keeps only the first line of a read error, so it stays one problem', () => {
    const out: string[] = [];
    const err: string[] = [];
    const code = run(['d/1.json'], {
      readFile: () => {
        throw new Error('EACCES: permission denied\nsecond line');
      },
      out: (text) => out.push(text),
      err: (text) => err.push(text),
    });
    assert.deepEqual(
      { code, out: out.join(''), err: err.join('') },
      { code: 1, out: 'cannot read the draft: EACCES: permission denied\n', err: '' },
    );
  });

  it('exits 2 with the usage when the draft is not named', () => {
    assert.deepEqual(runWith([], {}), {
      code: 2,
      out: '',
      err: 'usage: node scripts/issue-draft.ts <draft.json>\n',
    });
  });
});
