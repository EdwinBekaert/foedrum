import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  changedFiles,
  formatRule,
  proposeRule,
  type Rule,
  readCandidates,
  readRules,
  renderRules,
  selectRules,
} from '../../scripts/house-yeast/core.ts';

const fixtures = join(import.meta.dirname, '..', 'fixtures', 'house-yeast');
const ruleFiles = readdirSync(join(fixtures, 'rules')).map((name) => ({
  path: `.foedrum/house-yeast/${name}`,
  text: readFileSync(join(fixtures, 'rules', name), 'utf8'),
}));
// Read in each test, so a broken reader fails the tests and not the file.
const fixtureRules = (): Rule[] => readRules(ruleFiles).rules;
const candidates = readFileSync(join(fixtures, 'candidates.jsonl'), 'utf8');

const ids = (priced: readonly { rule: Rule }[]): string[] => priced.map(({ rule }) => rule.rule.id);
const selectedFor = (files: string[], lens = 'correctness', budget?: number): string[] =>
  ids(selectRules(fixtureRules(), { files, lens }, budget).selected);

const rule = (id: string, scope: Rule['rule']['scope'], body: string, created = '2026-10-01') => ({
  path: `.foedrum/house-yeast/${id}.md`,
  rule: { id, scope, kind: 'semantic', source: 's', created, status: 'active' } as const,
  body,
});

describe('readRules', () => {
  it('reads every fixture rule with its body', () => {
    const read = readRules(ruleFiles);
    assert.deepEqual(read.invalid, []);
    assert.equal(read.rules.length, ruleFiles.length);
    const lease = read.rules.find((r) => r.rule.id === 'lease-deadline');
    assert.match(lease?.body ?? '', /has a deadline/);
  });

  it('reports a file it cannot read, and one whose id is not its file name', () => {
    const [first] = ruleFiles;
    const read = readRules([
      { path: '.foedrum/house-yeast/broken.md', text: '---\n{ "id": \n---\nx' },
      { path: '.foedrum/house-yeast/other-name.md', text: first?.text ?? '' },
    ]);
    assert.deepEqual(read.rules, []);
    assert.deepEqual(
      read.invalid.map(({ path }) => path),
      ['.foedrum/house-yeast/broken.md', '.foedrum/house-yeast/other-name.md'],
    );
    assert.match(read.invalid[1]?.reason ?? '', /other-name/);
  });
});

describe('changedFiles', () => {
  it('takes added, altered and renamed files by their new path, and leaves out deleted ones', () => {
    const nameStatus = 'M\tsrc/a.ts\nA\tdocs/b.md\nR087\tsrc/old.ts\tsrc/new.ts\nD\tsrc/gone.ts\n';
    assert.deepEqual(changedFiles(nameStatus), ['src/a.ts', 'docs/b.md', 'src/new.ts']);
  });

  it('tolerates CRLF and blank lines', () => {
    assert.deepEqual(changedFiles('M\tsrc/a.ts\r\n\r\nC100\tsrc/a.ts\tsrc/c.ts\r\n'), [
      'src/a.ts',
      'src/c.ts',
    ]);
  });
});

describe('selectRules', () => {
  it('selects a rule for a file its scope matches, and not for an unrelated file', () => {
    assert.ok(selectedFor(['src/engine/lease.ts']).includes('lease-deadline'));
    assert.ok(!selectedFor(['docs/architecture.md']).includes('lease-deadline'));
    assert.ok(selectedFor(['test/unit/lease.test.ts']).includes('no-process-in-unit-tests'));
    assert.ok(!selectedFor(['src/engine/lease.ts']).includes('no-process-in-unit-tests'));
  });

  it('needs one file to match both the globs and the language', () => {
    assert.ok(!selectedFor(['src/engine/notes.md']).includes('lease-deadline'));
    assert.ok(
      selectedFor(['src/engine/notes.md', 'src/engine/lease.ts']).includes('lease-deadline'),
    );
  });

  it('selects a rule without globs or language for every change', () => {
    assert.ok(selectedFor(['README.md']).includes('lf-only'));
  });

  it('selects a rule scoped to a lens only for that lens, and first', () => {
    assert.ok(!selectedFor(['src/engine/lease.ts'], 'correctness').includes('tokens-in-logs'));
    assert.deepEqual(selectedFor(['src/engine/lease.ts'], 'security'), [
      'tokens-in-logs',
      'lease-deadline',
      'lf-only',
    ]);
  });

  it('never selects a retired rule, even when its scope matches', () => {
    assert.ok(!selectedFor(['src/engine/lease.ts', 'src/a.ts']).includes('string-paths'));
    assert.ok(!selectedFor(['src/a.ts']).includes('string-paths'));
  });

  it('cuts the lowest-priority rules to fit the budget, and names them', () => {
    const all = selectRules(fixtureRules(), {
      files: ['src/engine/lease.ts'],
      lens: 'correctness',
    });
    assert.deepEqual(ids(all.selected), ['lease-deadline', 'lf-only']);
    const budget = all.selected[0]?.tokens ?? 0;
    const cut = selectRules(
      fixtureRules(),
      { files: ['src/engine/lease.ts'], lens: 'correctness' },
      budget,
    );
    assert.deepEqual(ids(cut.selected), ['lease-deadline']);
    assert.deepEqual(ids(cut.cut), ['lf-only']);
  });

  it('orders newer rules first within one scope, and lets a short rule in after a long one', () => {
    const own = [
      rule('older', {}, 'Short.', '2026-01-01'),
      rule('long', {}, 'Long. '.repeat(100), '2026-03-01'),
      rule('newer', {}, 'Short too.', '2026-02-01'),
    ];
    const all = selectRules(own, { files: ['a.ts'], lens: 'correctness' });
    assert.deepEqual(ids(all.selected), ['long', 'newer', 'older']);
    const short = all.selected[1]?.tokens ?? 0;
    const fit = selectRules(own, { files: ['a.ts'], lens: 'correctness' }, short * 3);
    assert.deepEqual(ids(fit.selected), ['newer', 'older']);
    assert.deepEqual(ids(fit.cut), ['long']);
  });

  it('prices a rule at about a quarter of its length in characters', () => {
    const [priced] = selectRules([rule('x', {}, 'a'.repeat(400))], {
      files: ['a.ts'],
      lens: 'correctness',
    }).selected;
    assert.ok(
      priced !== undefined && priced.tokens >= 100 && priced.tokens <= 110,
      `${priced?.tokens}`,
    );
  });
});

describe('renderRules', () => {
  it('gives the lens each selected rule with its id, kind and body', () => {
    const text = renderRules(
      'security',
      selectRules(fixtureRules(), { files: ['src/engine/lease.ts'], lens: 'security' }),
    );
    assert.match(text, /## tokens-in-logs \(semantic\)\n\nNo log line holds a token/);
    assert.match(text, /## lf-only \(structural\)/);
    assert.ok(text.indexOf('tokens-in-logs') < text.indexOf('lf-only'));
  });

  it('says so when no rule matches', () => {
    assert.match(renderRules('correctness', { selected: [], cut: [] }), /No house-yeast rule/);
  });
});

describe('readCandidates', () => {
  it('reads every line of the fixture reviews and skips blank lines', () => {
    const read = readCandidates(candidates);
    assert.deepEqual(read.invalid, []);
    assert.equal(read.candidates.length, 4);
  });

  it('reports an invalid line by its number', () => {
    const read = readCandidates('{"lesson":"x"}\n\nnot json\n');
    assert.deepEqual(read.candidates, []);
    assert.deepEqual(
      read.invalid.map((line) => line.split(':')[0]),
      ['line 1', 'line 3'],
    );
  });
});

describe('proposeRule', () => {
  const fixtureSeen = () => readCandidates(candidates).candidates;

  it('proposes a lesson seen in two fixture reviews as a rule, from its newest occurrence', () => {
    const proposal = proposeRule(fixtureSeen(), 'deadline-on-every-wait', false);
    assert.deepEqual(proposal, {
      rule: {
        id: 'deadline-on-every-wait',
        scope: { globs: ['src/engine/**', 'src/cli/**'] },
        kind: 'semantic',
        source:
          'https://github.com/acme/foedrum/pull/101#issuecomment-1, https://github.com/acme/foedrum/pull/101#issuecomment-2, https://github.com/acme/foedrum/pull/102#discussion_r9',
        created: '2026-10-21',
        status: 'active',
      },
      body: 'Every wait in the engine or the Cellar has a deadline, so a batch never sits silently.',
      reviews: 2,
    });
  });

  it('does not propose a lesson seen in one review only, however often', () => {
    assert.equal(proposeRule(fixtureSeen(), 'no-shell-spawns', false), undefined);
    const once = fixtureSeen().filter((c) => c.review.endsWith('/101'));
    assert.equal(proposeRule(once, 'deadline-on-every-wait', false), undefined);
  });

  it('proposes a lesson seen once when the author asks for it, and none for an unknown lesson', () => {
    assert.equal(proposeRule(fixtureSeen(), 'no-shell-spawns', true)?.reviews, 1);
    assert.equal(proposeRule(fixtureSeen(), 'never-seen', true), undefined);
  });

  it('writes a rule file that a later review selects for a matching file only', () => {
    const proposal = proposeRule(fixtureSeen(), 'deadline-on-every-wait', false);
    assert.ok(proposal !== undefined);
    const read = readRules([
      {
        path: '.foedrum/house-yeast/deadline-on-every-wait.md',
        text: formatRule(proposal.rule, proposal.body),
      },
    ]);
    assert.deepEqual(read.invalid, []);
    assert.deepEqual(read.rules[0]?.rule, proposal.rule);
    const select = (file: string) =>
      ids(selectRules(read.rules, { files: [file], lens: 'correctness' }).selected);
    assert.deepEqual(select('src/cli/serve.ts'), ['deadline-on-every-wait']);
    assert.deepEqual(select('docs/glossary.md'), []);
  });
});
