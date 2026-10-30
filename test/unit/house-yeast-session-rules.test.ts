import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { sessionRuleFiles } from '../../scripts/house-yeast/session-rules.ts';
import { readRules, selectRules } from '../../src/brewers/house-yeast.ts';

const root = join(import.meta.dirname, '..', '..');

const ruleFile = (
  id: string,
  scope: Record<string, unknown>,
  body: string,
  status = 'active',
): { path: string; text: string } => ({
  path: `.foedrum/house-yeast/${id}.md`,
  text: `---\n${JSON.stringify({ id, scope, kind: 'semantic', source: 's', created: '2026-10-01', status })}\n---\n${body}\n`,
});

const generate = (...files: { path: string; text: string }[]) => sessionRuleFiles(files);

// The `paths` list of a generated file's frontmatter.
const pathsOf = (text: string): string[] => {
  const [, front = ''] = /^---\n([\s\S]*?)\n---\n/.exec(text) ?? [];
  return [...front.matchAll(/^ {2}- (".*")$/gm)].map(([, path]) => JSON.parse(path as string));
};

const named = (files: { name: string; text: string }[], name: string): string => {
  const file = files.find((f) => f.name === name);
  assert.ok(file, `${name} among ${files.map((f) => f.name).join(', ')}`);
  return file.text;
};

describe('sessionRuleFiles', () => {
  it('puts the rules of one set of globs in one file named after them, each glob under any folder, the rules by id', () => {
    const { files, invalid } = generate(
      ruleFile('zeta-rule', { globs: ['test/**/*.ts'] }, 'Zeta body.'),
      ruleFile('alpha-rule', { globs: ['src/**/*.ts'] }, 'Alpha body.'),
      ruleFile('beta-rule', { globs: ['test/**/*.ts'] }, 'Beta body.'),
    );
    assert.deepEqual(invalid, []);
    assert.deepEqual(
      files.map((f) => f.name),
      ['src-ts.md', 'test-ts.md'],
    );
    const test = named(files, 'test-ts.md');
    assert.deepEqual(pathsOf(test), ['**/test/**/*.ts']);
    assert.ok(test.includes('## beta-rule (semantic)\n\nBeta body.\n'), test);
    assert.ok(test.includes('## zeta-rule (semantic)\n\nZeta body.\n'), test);
    assert.ok(test.indexOf('## beta-rule') < test.indexOf('## zeta-rule'), test);
    assert.ok(!test.includes('alpha-rule'), test);
    assert.deepEqual(pathsOf(named(files, 'src-ts.md')), ['**/src/**/*.ts']);
  });

  it('puts rules whose globs differ only in order in one file', () => {
    const { files } = generate(
      ruleFile('one', { globs: ['src/**', 'CLAUDE.md'] }, 'One.'),
      ruleFile('two', { globs: ['CLAUDE.md', 'src/**'] }, 'Two.'),
    );
    assert.equal(files.length, 1);
    const [file] = files;
    assert.deepEqual(pathsOf(file?.text ?? ''), ['**/CLAUDE.md', '**/src/**']);
    assert.ok(file?.text.includes('## one (') && file.text.includes('## two ('), file?.text);
  });

  it("scopes a rule with only a language to that language's extensions", () => {
    const { files } = generate(ruleFile('typed', { language: 'typescript' }, 'Typed.'));
    assert.deepEqual(
      files.map((f) => f.name),
      ['typescript.md'],
    );
    assert.deepEqual(pathsOf(named(files, 'typescript.md')), ['**/*.{ts,tsx,mts,cts}']);
  });

  it('scopes a rule with globs and a language by its globs', () => {
    const { files } = generate(
      ruleFile('both', { globs: ['docs/design/**'], language: 'markdown' }, 'Both.'),
    );
    assert.deepEqual(pathsOf(files[0]?.text ?? ''), ['**/docs/design/**']);
  });

  it('keeps a glob that already starts under any folder as it is', () => {
    const { files } = generate(ruleFile('any', { globs: ['**/*.md'] }, 'Any.'));
    assert.deepEqual(pathsOf(files[0]?.text ?? ''), ['**/*.md']);
  });

  it('gives a rule of every lens, since the session writes the change', () => {
    const { files } = generate(
      ruleFile('lensed', { globs: ['src/**/*.ts'], lens: 'test-design' }, 'Lensed.'),
    );
    assert.ok(files[0]?.text.includes('## lensed (semantic)\n\nLensed.\n'), files[0]?.text);
  });

  it('leaves a retired rule out, and makes no file for globs only retired rules have', () => {
    const { files } = generate(
      ruleFile('kept', { globs: ['src/**/*.ts'] }, 'Kept.'),
      ruleFile('gone', { globs: ['src/**/*.ts'] }, 'Gone.', 'retired'),
      ruleFile('alone', { globs: ['docs/**'] }, 'Alone.', 'retired'),
    );
    assert.deepEqual(
      files.map((f) => f.name),
      ['src-ts.md'],
    );
    assert.ok(!files[0]?.text.includes('gone'), files[0]?.text);
  });

  it('names an invalid rule file and makes no file of it', () => {
    const { files, invalid } = generate(ruleFile('kept', { globs: ['src/**/*.ts'] }, 'Kept.'), {
      path: '.foedrum/house-yeast/broken.md',
      text: 'no frontmatter\n',
    });
    assert.deepEqual(
      invalid.map((i) => i.path),
      ['.foedrum/house-yeast/broken.md'],
    );
    assert.deepEqual(
      files.map((f) => f.name),
      ['src-ts.md'],
    );
  });

  it('gives two sets of globs with the same name distinct files', () => {
    const { files } = generate(
      ruleFile('slash', { globs: ['docs/a.md'] }, 'Slash.'),
      ruleFile('dash', { globs: ['docs-a.md'] }, 'Dash.'),
    );
    assert.deepEqual(
      files.map((f) => f.name),
      ['docs-a-md-2.md', 'docs-a-md.md'],
    );
    const first = named(files, 'docs-a-md.md');
    const second = named(files, 'docs-a-md-2.md');
    assert.deepEqual(pathsOf(first), ['**/docs-a.md']);
    assert.ok(first.includes('## dash (') && !first.includes('## slash ('), first);
    assert.deepEqual(pathsOf(second), ['**/docs/a.md']);
    assert.ok(second.includes('## slash (') && !second.includes('## dash ('), second);
  });

  it("leaves /brew-review's selection by lens as it is, from the same rule files", () => {
    const files = [
      ruleFile('lensed', { globs: ['src/**/*.ts'], lens: 'test-design' }, 'Lensed.'),
      ruleFile('plain', { globs: ['src/**/*.ts'] }, 'Plain.'),
    ];
    const { rules, invalid } = readRules(files);
    assert.deepEqual(invalid, []);
    const selectedFor = (lens: string): string[] =>
      selectRules(rules, { files: ['src/a.ts'], lens }).selected.map(({ rule }) => rule.rule.id);
    assert.deepEqual(selectedFor('correctness'), ['plain']);
    assert.deepEqual(selectedFor('test-design'), ['lensed', 'plain']);
  });

  it('matches the committed files in .claude/rules/house-yeast/ (run npm run house-yeast:rules after changing a rule)', () => {
    const rules = join(root, '.foedrum', 'house-yeast');
    const { files, invalid } = sessionRuleFiles(
      readdirSync(rules)
        .filter((name) => name.endsWith('.md'))
        .map((name) => ({
          path: `.foedrum/house-yeast/${name}`,
          text: readFileSync(join(rules, name), 'utf8'),
        })),
    );
    assert.deepEqual(invalid, []);
    const generated = join(root, '.claude', 'rules', 'house-yeast');
    const committed = readdirSync(generated)
      .sort()
      .map((name) => ({ name, text: readFileSync(join(generated, name), 'utf8') }));
    assert.deepEqual(committed, files);
  });
});
