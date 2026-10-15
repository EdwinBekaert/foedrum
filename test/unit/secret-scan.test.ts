// The secret scan's matching and its exit codes, with file reading and the commit lookup
// injected. The script with real node and git runs in test/integration/secret-scan.test.ts.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findSecrets, type IsCommit, run } from '../../scripts/secret-scan.ts';

// Synthetic secrets, built at run time so the source never holds a token-shaped string.
const githubToken = `ghp${'_'}${'a1B2'.repeat(9)}`;
const fineGrainedToken = `github${'_pat_'}${'a1B2'.repeat(15)}`;
const npmToken = `npm${'_'}${'a1B2'.repeat(9)}`;
const apiKey = `sk${'-'}${'a1B2'.repeat(10)}`;
const awsKeyId = `AKIA${'A1B2'.repeat(4)}`;
const privateKey = `-----BEGIN ${'RSA PRIVATE'} KEY-----`;
const base64Secret = `${'Zm9vYmFy'.repeat(4)}QUJDRA12`;
const fortyHex = `${'c0ffee'.repeat(6)}beef`;

const noCommits: IsCommit = () => false;
const allCommits: IsCommit = () => true;

describe('findSecrets', () => {
  it('reports a GitHub token with its line number', () => {
    const found = findSecrets(`## Review\n\nposted with ${githubToken} by mistake\n`, noCommits);
    assert.equal(found.length, 1);
    assert.equal(found[0]?.line, 3);
  });

  for (const [name, text] of [
    ['a fine-grained GitHub token', fineGrainedToken],
    ['an npm token', npmToken],
    ['an API key starting with sk-', apiKey],
    ['an AWS access key id', awsKeyId],
    ['a private key header', privateKey],
    ['an npm _authToken setting', '//registry.npmjs.org/:_authToken=abc123'],
    ['a password assignment', 'password=hunter2'],
    ['a token assignment', 'token=abc123'],
    ['a long base64 string', base64Secret],
    ['a 64-character hexadecimal string', 'ab12'.repeat(16)],
  ]) {
    it(`reports ${name}`, () => {
      assert.equal(findSecrets(`line one\n${text}\n`, noCommits).length, 1);
    });
  }

  it('skips a 40-character hexadecimal string that is a commit in this repository', () => {
    const asked: string[] = [];
    const isCommit: IsCommit = (sha) => {
      asked.push(sha);
      return true;
    };
    assert.deepEqual(findSecrets(`Base \`${fortyHex}\`\n`, isCommit), []);
    assert.deepEqual(asked, [fortyHex]);
  });

  it('reports a 40-character hexadecimal string that is not a commit', () => {
    assert.equal(findSecrets(`value ${fortyHex}\n`, noCommits).length, 1);
  });

  it('reports a long hexadecimal string that is not 40 characters, even if git knows it', () => {
    assert.equal(findSecrets(`value ${'ab12'.repeat(16)}\n`, allCommits).length, 1);
  });

  it('reports nothing in an ordinary summary', () => {
    const summary = [
      '## Review: `23-review-skill` @ `eba9fe7`',
      '| 1 | correctness | major | `.claude/skills/brew-review/SKILL.md:45` | Commits fall through | fixed in `e2163c4` |',
      'Run `npm run check`, then `gh pr comment 31 --body-file "<bundle>/summary.md"`.',
      'A tokenizer splits the token; a password field is masked.',
    ].join('\n');
    assert.deepEqual(findSecrets(summary, noCommits), []);
  });

  it('never repeats the whole secret in its report', () => {
    const [match] = findSecrets(githubToken, noCommits);
    assert.ok(match);
    assert.ok(!match.excerpt.includes(githubToken));
  });

  it('tolerates CRLF line endings', () => {
    assert.equal(findSecrets(`one\r\ntwo\r\n${githubToken}\r\n`, noCommits)[0]?.line, 3);
  });
});

describe('run', () => {
  const runWith = (args: string[], files: Record<string, string>, isCommit = noCommits) => {
    const out: string[] = [];
    const err: string[] = [];
    const read: string[] = [];
    const readFile = (file: string): string => {
      read.push(file);
      const text = files[file];
      if (text === undefined) throw new Error(`ENOENT: no such file, open '${file}'`);
      return text;
    };
    const status = run(args, {
      readFile,
      isCommit,
      out: (text) => out.push(text),
      err: (text) => err.push(text),
    });
    return { status, out: out.join(''), err: err.join(''), read };
  };

  it('exits 0 silently for a summary without secrets, reading the named file', () => {
    const result = runWith(['summary.md'], { 'summary.md': '## Review\n\nAll good.\n' });
    assert.deepEqual(result, { status: 0, out: '', err: '', read: ['summary.md'] });
  });

  it('exits 0 when the only long hex string is a commit of this repository', () => {
    const result = runWith(['summary.md'], { 'summary.md': `Base \`${fortyHex}\`\n` }, allCommits);
    assert.equal(result.status, 0);
    assert.equal(result.out, '');
  });

  it('exits 1 and prints one line per secret, naming its line without the secret', () => {
    const result = runWith(['summary.md'], { 'summary.md': `fine\n${githubToken}\n${apiKey}\n` });
    assert.equal(result.status, 1);
    assert.deepEqual(result.out.split('\n'), [
      'line 2: GitHub token ghp_… (40 characters)',
      'line 3: API key sk-a… (43 characters)',
      '',
    ]);
    assert.ok(!result.out.includes(githubToken));
    assert.equal(result.err, '');
  });

  it('exits 2 with usage on stderr when no file is given', () => {
    const result = runWith([], {});
    assert.equal(result.status, 2);
    assert.match(result.err, /^usage: node scripts\/secret-scan\.ts <file>/);
    assert.deepEqual(result.read, []);
  });

  it('exits 2 naming the file when it cannot be read', () => {
    const result = runWith(['missing.md'], {});
    assert.equal(result.status, 2);
    assert.match(result.err, /cannot read missing\.md: ENOENT/);
    assert.equal(result.out, '');
  });
});
