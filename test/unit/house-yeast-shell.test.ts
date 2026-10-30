import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { sessionRuleFiles } from '../../scripts/house-yeast/session-rules.ts';
import { run } from '../../scripts/house-yeast.ts';

const fixtures = join(import.meta.dirname, '..', 'fixtures', 'house-yeast');
const fixtureRules = Object.fromEntries(
  readdirSync(join(fixtures, 'rules')).map((name) => [
    `base/.foedrum/house-yeast/${name}`,
    readFileSync(join(fixtures, 'rules', name), 'utf8'),
  ]),
);

// An in-memory file system: paths with `/`, folders implied by the files in them.
const runWith = (args: string[], start: Record<string, string>, denied: string[] = []) => {
  const files = { ...start };
  const out: string[] = [];
  const err: string[] = [];
  const missing = (path: string) =>
    Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), {
      code: 'ENOENT',
    });
  const deny = (path: string) => {
    if (denied.includes(path)) {
      throw Object.assign(new Error(`EACCES: permission denied, open '${path}'`), {
        code: 'EACCES',
      });
    }
  };
  const code = run(args, {
    readFile: (path) => {
      deny(path);
      const text = files[path];
      if (text === undefined) throw missing(path);
      return text;
    },
    readDir: (dir) => {
      deny(dir);
      const names = Object.keys(files)
        .filter((path) => path.startsWith(`${dir}/`))
        .map((path) => path.slice(dir.length + 1));
      if (names.length === 0) throw missing(dir);
      return names;
    },
    exists: (path) => path in files,
    writeFile: (path, text) => {
      files[path] = text;
    },
    appendFile: (path, text) => {
      files[path] = (files[path] ?? '') + text;
    },
    removeFile: (path) => {
      delete files[path];
    },
    out: (text) => out.push(text),
    err: (text) => err.push(text),
  });
  return { code, out: out.join(''), err: err.join(''), files };
};

const candidate = (review: string, extra: object = {}) =>
  JSON.stringify({
    lesson: 'deadline-on-every-wait',
    review,
    source: `${review}#discussion_r1`,
    seen: '2026-10-22',
    kind: 'structural',
    scope: { globs: ['src/engine/**'] },
    rule: 'Every wait in the engine has a deadline.',
    ...extra,
  });

describe('node scripts/house-yeast.ts select', () => {
  const select = ['select', 'base/.foedrum/house-yeast', 'review/files.txt'];

  it('writes the rules that match the change for the lens, and names each one', () => {
    const result = runWith([...select, 'correctness', 'review/house-yeast/correctness.md'], {
      ...fixtureRules,
      'review/files.txt': 'M\tsrc/engine/lease.ts\n',
    });
    assert.equal(result.code, 0, result.err);
    const written = result.files['review/house-yeast/correctness.md'] ?? '';
    assert.match(written, /## lease-deadline/);
    assert.match(written, /## lf-only/);
    assert.doesNotMatch(written, /no-process-in-unit-tests|string-paths|tokens-in-logs/);
    assert.match(result.out, /^selected lease-deadline \(\d+ tokens\)$/m);
    assert.match(result.out, /^selected lf-only \(\d+ tokens\), promotion candidate$/m);
  });

  it('does not select a rule for an unrelated file', () => {
    const result = runWith([...select, 'correctness', 'out.md'], {
      ...fixtureRules,
      'review/files.txt': 'M\tdocs/glossary.md\n',
    });
    assert.equal(result.code, 0, result.err);
    assert.match(result.files['out.md'] ?? '', /## lf-only/);
    assert.doesNotMatch(result.files['out.md'] ?? '', /lease-deadline/);
    assert.doesNotMatch(result.out, /lease-deadline/);
  });

  it('names the rules the budget cuts, and invalid rule files', () => {
    const result = runWith([...select, 'correctness', 'out.md', '--budget', '30'], {
      ...fixtureRules,
      'base/.foedrum/house-yeast/broken.md': 'no frontmatter',
      'base/.foedrum/house-yeast/README.txt': 'not a rule',
      'review/files.txt': 'M\tsrc/engine/lease.ts\n',
    });
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /^invalid base\/\.foedrum\/house-yeast\/broken\.md: /m);
    assert.doesNotMatch(result.out, /README/);
    assert.match(result.out, /^cut lease-deadline \(\d+ tokens\): over the budget of 30$/m);
    assert.match(result.out, /^selected lf-only/m);
  });

  it('flags a rule without a scope as due for curation also when the budget cuts it', () => {
    const result = runWith([...select, 'correctness', 'out.md', '--budget', '10'], {
      ...fixtureRules,
      'review/files.txt': 'M\tsrc/engine/lease.ts\n',
    });
    assert.match(result.out, /^cut lf-only /m);
    assert.match(result.out, /^no scope lf-only: selected for every change, due for curation$/m);
  });

  it('writes that no rule matches when the folder has no rules', () => {
    const result = runWith([...select, 'security', 'out.md'], { 'review/files.txt': 'M\ta.ts\n' });
    assert.equal(result.code, 0, result.err);
    assert.match(result.files['out.md'] ?? '', /No house-yeast rule matches/);
  });

  it('exits 1 when the rules folder exists but cannot be read, instead of finding no rules', () => {
    const result = runWith(
      [...select, 'security', 'out.md'],
      { ...fixtureRules, 'review/files.txt': 'M\ta.ts\n' },
      ['base/.foedrum/house-yeast'],
    );
    assert.equal(result.code, 1);
    assert.match(result.out, /^cannot read the rules: EACCES/);
    assert.equal('out.md' in result.files, false);
  });

  it('exits 1 when the changed files cannot be read, and 2 on a bad budget', () => {
    assert.equal(runWith([...select, 'security', 'out.md'], fixtureRules).code, 1);
    const files = { 'review/files.txt': 'M\ta.ts\n' };
    assert.equal(runWith([...select, 'security', 'out.md', '--budget', 'lots'], files).code, 2);
  });
});

describe('node scripts/house-yeast.ts record', () => {
  const store = 'main/.foedrum/house-yeast-candidates.jsonl';
  const record = ['record', store, 'c.json', 'head/.foedrum/house-yeast'];
  const rulePath = 'head/.foedrum/house-yeast/deadline-on-every-wait.md';
  const sessionDir = 'head/.claude/rules/house-yeast';
  const sessionFiles = (files: Record<string, string>) =>
    Object.fromEntries(Object.entries(files).filter(([path]) => path.startsWith(`${sessionDir}/`)));
  const headRules = Object.fromEntries(
    Object.entries(fixtureRules).map(([path, text]) => [path.replace(/^base\//, 'head/'), text]),
  );

  it('regenerates the session rule files beside the rules when it proposes one (ADR 0271)', () => {
    const result = runWith([...record, '--asked'], {
      ...headRules,
      'c.json': candidate('1-engine-waits'),
      [`${sessionDir}/stale.md`]: 'from an older set of rules',
    });
    assert.equal(result.code, 0, result.err);
    const rules = Object.entries(result.files)
      .filter(([path]) => path.startsWith('head/.foedrum/house-yeast/'))
      .map(([path, text]) => ({ path, text }));
    const expected = sessionRuleFiles(rules);
    assert.deepEqual(expected.invalid, []);
    assert.deepEqual(
      sessionFiles(result.files),
      Object.fromEntries(expected.files.map(({ name, text }) => [`${sessionDir}/${name}`, text])),
    );
    assert.match(result.files[`${sessionDir}/src-engine.md`] ?? '', /## deadline-on-every-wait \(/);
    assert.ok(
      result.out.endsWith(`\nregenerated ${sessionDir}: ${expected.files.length} files\n`),
      result.out,
    );
  });

  it('leaves the session rule files alone when it writes no rule', () => {
    const stale = { [`${sessionDir}/stale.md`]: 'kept' };
    const once = runWith(record, { 'c.json': candidate('1-engine-waits'), ...stale });
    assert.equal(once.out, 'recorded deadline-on-every-wait: seen in 1 review\n');
    assert.deepEqual(sessionFiles(once.files), stale);
    const kept = runWith([...record, '--asked'], {
      'c.json': candidate('1-engine-waits'),
      [rulePath]: 'mine',
      ...stale,
    });
    assert.equal(kept.out, `exists ${rulePath}: not overwritten\n`);
    assert.deepEqual(sessionFiles(kept.files), stale);
  });

  it('exits 1 naming an invalid rule beside the new one, and writes no session rule file', () => {
    const result = runWith([...record, '--asked'], {
      'c.json': candidate('1-engine-waits'),
      'head/.foedrum/house-yeast/broken.md': 'no frontmatter\n',
    });
    assert.equal(result.code, 1);
    assert.equal(rulePath in result.files, true);
    assert.match(
      result.out,
      /^cannot regenerate the session rules: head\/\.foedrum\/house-yeast\/broken\.md: /m,
    );
    assert.deepEqual(sessionFiles(result.files), {});
  });

  it('records a lesson seen once, and proposes nothing', () => {
    const pr1 = '1-engine-waits';
    const result = runWith(record, { 'c.json': candidate(pr1) });
    assert.equal(result.code, 0, result.err);
    assert.equal(result.out, 'recorded deadline-on-every-wait: seen in 1 review\n');
    assert.deepEqual(JSON.parse(result.files[store] ?? ''), JSON.parse(candidate(pr1)));
    assert.equal(rulePath in result.files, false);
  });

  it('proposes a rule file when the lesson recurs in a second review', () => {
    const pr1 = '1-engine-waits';
    const pr2 = '2-cellar-waits';
    const result = runWith(record, {
      [store]: candidate(pr1), // a store without a final line break
      'c.json': JSON.stringify(JSON.parse(candidate(pr2)), null, 2),
    });
    assert.equal(result.code, 0, result.err);
    assert.equal(
      result.out,
      `proposed ${rulePath}: seen in 2 reviews\nregenerated ${sessionDir}: 1 file\n`,
    );
    assert.equal((result.files[store] ?? '').split('\n').filter(Boolean).length, 2);
    assert.match(result.files[rulePath] ?? '', /"id": "deadline-on-every-wait"/);
    assert.match(result.files[rulePath] ?? '', /Every wait in the engine has a deadline\.\n$/);
  });

  it('proposes a rule asked for, and never overwrites an existing rule file', () => {
    const pr1 = '1-engine-waits';
    const asked = runWith([...record, '--asked'], { 'c.json': candidate(pr1) });
    assert.equal(asked.out, `proposed ${rulePath}: asked for\nregenerated ${sessionDir}: 1 file\n`);
    const kept = runWith([...record, '--asked'], { 'c.json': candidate(pr1), [rulePath]: 'mine' });
    assert.equal(kept.out, `exists ${rulePath}: not overwritten\n`);
    assert.equal(kept.files[rulePath], 'mine');
  });

  it('reads a candidate file that starts with a byte order mark', () => {
    const pr1 = '1-engine-waits';
    const result = runWith(record, { 'c.json': String.fromCodePoint(0xfeff) + candidate(pr1) });
    assert.equal(result.out, 'recorded deadline-on-every-wait: seen in 1 review\n');
  });

  it('exits 1 when the store exists but cannot be read, and records nothing', () => {
    const files = { 'c.json': candidate('1-engine-waits'), [store]: '' };
    const result = runWith(record, files, [store]);
    assert.equal(result.code, 1);
    assert.match(result.out, /^cannot read the candidates: EACCES/);
    assert.equal(result.files[store], '');
  });

  it('refuses an invalid candidate with its reason, and records nothing', () => {
    const result = runWith(record, { 'c.json': candidate('pr', { lesson: '../x' }) });
    assert.equal(result.code, 1);
    assert.match(result.out, /^invalid candidate: /);
    assert.equal(store in result.files, false);
  });
});

describe('node scripts/house-yeast.ts select, rules without a scope', () => {
  it('flags a rule selected for every change as due for curation (ADR 0015)', () => {
    const result = runWith(
      ['select', 'base/.foedrum/house-yeast', 'review/files.txt', 'correctness', 'out.md'],
      { ...fixtureRules, 'review/files.txt': 'M\tsrc/engine/lease.ts\n' },
    );
    assert.match(result.out, /^no scope lf-only: selected for every change, due for curation$/m);
    assert.doesNotMatch(result.out, /^no scope lease-deadline/m);
  });
});

describe('node scripts/house-yeast.ts list', () => {
  it('lists each lesson once with its reviews and newest rule', () => {
    const pr1 = '1-engine-waits';
    const result = runWith(['list', 'store.jsonl'], {
      'store.jsonl': `${candidate(pr1)}\n${candidate(pr1, { rule: 'Newer text.' })}\nbad\n`,
    });
    assert.equal(result.code, 0, result.err);
    const [invalid, lesson, end] = result.out.split('\n');
    assert.match(invalid ?? '', /^invalid line 3: /);
    assert.equal(lesson, 'deadline-on-every-wait (structural, 1 review): Newer text.');
    assert.equal(end, '');
  });

  it('says there are no candidates when the store does not exist', () => {
    assert.equal(runWith(['list', 'store.jsonl'], {}).out, 'no candidates\n');
  });
});

describe('node scripts/house-yeast.ts', () => {
  it('prints the usage and exits 2 without a known command', () => {
    for (const args of [[], ['forget'], ['record', 'store.jsonl']]) {
      const result = runWith(args, {});
      assert.equal(result.code, 2, args.join(' '));
      assert.match(result.err, /^usage:/);
    }
  });
});
