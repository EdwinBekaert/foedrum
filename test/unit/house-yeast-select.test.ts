import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  blobTexts,
  breweryRules,
  changedFilesZ,
  pickRules,
  type RuleFile,
  readRules,
  ruleBlobs,
  selectRules,
} from '../../src/brewers/house-yeast.ts';

const ruleText = (id: string, scope: object, body: string, created = '2026-10-01'): string =>
  `---\n${JSON.stringify({ id, scope, kind: 'semantic', source: 'review of #1', created, status: 'active' })}\n---\n${body}\n`;

const file = (path: string, scope: object, body = `The rule of ${path}.`): RuleFile => {
  const id = (path.split('/').at(-1) ?? '').replace(/\.md$/, '');
  return { path, text: ruleText(id, scope, body) };
};

const ids = (picked: { rule: { rule: { id: string } } }[]): string[] =>
  picked.map(({ rule }) => rule.rule.id);

describe('selectRules: the lens of a recipe step (ADR 0169)', () => {
  const rules = () =>
    readRules([
      file('.foedrum/house-yeast/by-name.md', { lens: 'correctness' }),
      file('.foedrum/house-yeast/by-folder.md', { lens: 'diff/correctness' }),
      file('.foedrum/house-yeast/plan-only.md', { lens: 'plan/correctness' }),
      file('.foedrum/house-yeast/other-lens.md', { lens: 'security' }),
      file('.foedrum/house-yeast/no-lens.md', {}),
    ]);

  it('reads a lens named with its folder', () => {
    assert.deepEqual(rules().invalid, []);
  });

  it('matches a lens by its name in either folder, or by its folder and name', () => {
    const { selected } = selectRules(rules().rules, {
      files: ['src/a.ts'],
      lens: 'diff/correctness',
    });
    assert.deepEqual(ids(selected).sort(), ['by-folder', 'by-name', 'no-lens']);
    const plan = selectRules(rules().rules, { files: ['src/a.ts'], lens: 'plan/correctness' });
    assert.deepEqual(ids(plan.selected).sort(), ['by-name', 'no-lens', 'plan-only']);
  });

  it('takes a lens given without its folder, as /brew-review gives it, as the diff lens of that name', () => {
    const { selected } = selectRules(rules().rules, { files: ['src/a.ts'], lens: 'correctness' });
    assert.deepEqual(ids(selected).sort(), ['by-folder', 'by-name', 'no-lens']);
  });

  it('gives a step without a lens only the rules that name none', () => {
    const { selected } = selectRules(rules().rules, { files: ['src/a.ts'] });
    assert.deepEqual(ids(selected), ['no-lens']);
  });

  it('leaves out a rule whose lens names another folder, no name, or a name in capitals', () => {
    const { rules: read, invalid } = readRules([
      file('.foedrum/house-yeast/other-folder.md', { lens: 'review/correctness' }),
      file('.foedrum/house-yeast/no-name.md', { lens: 'diff/' }),
      file('.foedrum/house-yeast/capitals.md', { lens: 'diff/Correctness' }),
    ]);
    assert.deepEqual(read, []);
    assert.deepEqual(
      invalid.map(({ path }) => path),
      [
        '.foedrum/house-yeast/other-folder.md',
        '.foedrum/house-yeast/no-name.md',
        '.foedrum/house-yeast/capitals.md',
      ],
    );
  });
});

describe('changedFilesZ: what git diff --name-status -z printed', () => {
  it('takes each file the change adds, alters or renames, by its new path, as git wrote it', () => {
    const printed = [
      'M',
      'src/a"b.ts',
      'R100',
      'old.ts',
      'new\tname.ts',
      'D',
      'gone.ts',
      'C075',
      'a.ts',
      'b.ts',
      'A',
      'x\\y.md',
      '',
    ];
    assert.deepEqual(changedFilesZ(printed.join('\0')), [
      'src/a"b.ts',
      'new\tname.ts',
      'b.ts',
      'x\\y.md',
    ]);
  });

  it('takes none from a change that touched nothing', () => {
    assert.deepEqual(changedFilesZ(''), []);
  });
});

describe('ruleBlobs: what git ls-tree -z listed', () => {
  it('takes the regular .md files directly in the folder, not links, folders or other files', () => {
    const listed = [
      '100644 blob aaaa\t.foedrum/house-yeast/a.md',
      '100755 blob bbbb\t.foedrum/house-yeast/b.md',
      '120000 blob cccc\t.foedrum/house-yeast/link.md',
      '040000 tree dddd\t.foedrum/house-yeast/folder.md',
      '100644 blob eeee\t.foedrum/house-yeast/notes.txt',
      '160000 commit ffff\t.foedrum/house-yeast/sub.md',
      '',
    ].join('\0');
    assert.deepEqual(ruleBlobs(listed), [
      { path: '.foedrum/house-yeast/a.md', blob: 'aaaa' },
      { path: '.foedrum/house-yeast/b.md', blob: 'bbbb' },
    ]);
  });

  it('lists none for a folder git does not have', () => {
    assert.deepEqual(ruleBlobs(''), []);
  });
});

describe('blobTexts: what git cat-file --batch printed', () => {
  const blobs = [
    { path: '.foedrum/house-yeast/a.md', blob: 'aaaa' },
    { path: '.foedrum/house-yeast/b.md', blob: 'bbbb' },
  ];

  it('reads each blob by its size in bytes, with text past one byte a character', () => {
    const a = 'Amounts are in cents: 5 €.\n';
    const b = 'Second\nrule\n';
    const batch = `aaaa blob ${Buffer.byteLength(a)}\n${a}\nbbbb blob ${Buffer.byteLength(b)}\n${b}\n`;
    assert.deepEqual(blobTexts(blobs, batch), [
      { path: '.foedrum/house-yeast/a.md', text: a },
      { path: '.foedrum/house-yeast/b.md', text: b },
    ]);
  });

  it('leaves out a blob that is not UTF-8 as unreadable, and reads the blobs after it', () => {
    // A byte that is not UTF-8 (0xE9, an é in Windows-1252) reaches it as U+FFFD, three bytes for
    // the one git counted.
    const batch = 'aaaa blob 5\ncaf�!\nbbbb blob 2\ny\n\n';
    assert.deepEqual(blobTexts(blobs, batch), [
      { path: '.foedrum/house-yeast/a.md', unreadable: 'it is not UTF-8 text' },
      { path: '.foedrum/house-yeast/b.md', text: 'y\n' },
    ]);
    assert.deepEqual(blobTexts(blobs, 'aaaa blob 1\nx\nbbbb blob 1\n�\n')[1], {
      path: '.foedrum/house-yeast/b.md',
      unreadable: 'it is not UTF-8 text',
    });
  });

  it('throws on a missing object, another id or output cut short', () => {
    assert.throws(() => blobTexts(blobs, 'aaaa missing\nbbbb blob 1\nx\n'), /aaaa/);
    assert.throws(() => blobTexts(blobs, 'cccc blob 1\nx\nbbbb blob 1\ny\n'), /aaaa/);
    assert.throws(() => blobTexts(blobs, 'aaaa blob 1\nx\nbbbb blob 10\ny\n'), /bbbb/);
  });
});

describe('breweryRules: the layers of the Brewery’s house-yeast/', () => {
  const files = [
    { path: 'house-yeast/cents.md', text: 'x' },
    { path: 'house-yeast/Acme/Web/web-rule.md', text: 'y' },
    { path: 'house-yeast/acme/api/api-rule.md', text: 'z' },
    // A sibling whose name starts with the repository's, and a file a folder deeper: neither is
    // its rule.
    { path: 'house-yeast/acme/web-old/old-rule.md', text: 'o' },
    { path: 'house-yeast/acme/web/deeper/deep-rule.md', text: 'd' },
    { path: 'house-yeast/broken.md', unreadable: 'EACCES' },
  ];

  it('takes the files directly in house-yeast/ as the Brewery layer', () => {
    const { brewery, repository } = breweryRules(files, 'acme/web', 'repo');
    assert.deepEqual(
      brewery.map(({ path }) => path),
      ['house-yeast/cents.md', 'house-yeast/broken.md'],
    );
    assert.deepEqual(repository, []);
  });

  it('names a folder of rules it could not list in the layer it holds', () => {
    const unlisted = [
      { path: 'house-yeast', unreadable: 'EACCES' },
      { path: 'house-yeast/Acme/Web', unreadable: 'EPERM' },
      { path: 'house-yeast/acme/web-old', unreadable: 'EIO' },
    ];
    const { brewery, repository } = breweryRules(unlisted, 'acme/web', 'brewery');
    assert.deepEqual(brewery, [{ path: 'house-yeast', unreadable: 'EACCES' }]);
    assert.deepEqual(repository, [{ path: 'house-yeast/Acme/Web', unreadable: 'EPERM' }]);
  });

  it("takes a repository's folder, in any case, when the Brewery keeps its rules", () => {
    const { repository } = breweryRules(files, 'acme/web', 'brewery');
    assert.deepEqual(
      repository.map(({ path }) => path),
      ['house-yeast/Acme/Web/web-rule.md'],
    );
  });
});

describe('pickRules: the rules one attempt gets (ADR 0169)', () => {
  const repository = [
    file('.foedrum/house-yeast/cents.md', { globs: ['src/**'] }, 'Repository: integers in cents.'),
    file('.foedrum/house-yeast/docs-only.md', { globs: ['docs/**'] }),
    { path: '.foedrum/house-yeast/broken.md', text: '---\n{ "id": \n---\nx' },
  ];
  const brewery = [
    file('house-yeast/cents.md', { globs: ['src/**'] }, 'Brewery: amounts as floats.'),
    file('house-yeast/deadline.md', { lens: 'correctness' }, 'Every wait has a deadline.'),
    { path: 'house-yeast/unread.md', unreadable: 'EACCES' },
  ];

  it("selects from both layers, the repository's rule over the Brewery's of its id", () => {
    const { inputs, record } = pickRules(
      { repository, brewery },
      { files: ['src/pay.ts'], lens: 'diff/correctness' },
    );
    assert.deepEqual(record.selected, ['deadline', 'cents']);
    assert.deepEqual(record.cut, []);
    assert.deepEqual(
      inputs.map(({ name, source }) => ({ name, source })),
      [
        {
          name: 'houseYeast',
          source: { kind: 'house-yeast', rule: 'deadline', path: 'house-yeast/deadline.md' },
        },
        {
          name: 'houseYeast',
          source: { kind: 'house-yeast', rule: 'cents', path: '.foedrum/house-yeast/cents.md' },
        },
      ],
    );
    assert.match(
      inputs[1]?.text ?? '',
      /^## cents \(semantic\)\n\nRepository: integers in cents\./,
    );
    assert.ok(!inputs.some(({ text }) => text.includes('floats')));
  });

  it('names the files it left out as invalid, from both layers', () => {
    const { record } = pickRules({ repository, brewery }, { files: [] });
    assert.deepEqual(record.invalid, ['.foedrum/house-yeast/broken.md', 'house-yeast/unread.md']);
  });

  it('leaves out a Brewery rule file that is not UTF-8, as it does a repository one', () => {
    // The file system read it as UTF-8, and its byte that is not became U+FFFD.
    const garbled = file('house-yeast/accents.md', {}, 'Caf�.');
    const { inputs, record } = pickRules({ repository: [], brewery: [garbled] }, { files: [] });
    assert.deepEqual(inputs, []);
    assert.deepEqual(record, { selected: [], cut: [], invalid: ['house-yeast/accents.md'] });
  });

  it('records the rules the budget cut', () => {
    const { inputs, record } = pickRules({ repository, brewery }, { files: ['src/pay.ts'] }, 12);
    assert.deepEqual(record.selected, []);
    assert.deepEqual(record.cut, ['cents']);
    assert.deepEqual(inputs, []);
  });

  it('gives a change that touched nothing only the rules that name no file', () => {
    const { record } = pickRules({ repository, brewery }, { files: [] }, undefined);
    assert.deepEqual(record, {
      selected: [],
      cut: [],
      invalid: ['.foedrum/house-yeast/broken.md', 'house-yeast/unread.md'],
    });
  });
});
