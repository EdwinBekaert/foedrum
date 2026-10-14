import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { findSecrets, type IsCommit } from '../../scripts/secret-scan.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';

const root = join(import.meta.dirname, '..', '..');
const script = join(root, 'scripts', 'secret-scan.ts');

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

describe('secret-scan command', () => {
  let dir: TempDir;
  before(() => {
    dir = makeTempDir('secret-scan');
  });
  after(() => dir.remove());

  const scan = (content: string) => {
    const file = join(dir.path, 'summary.md');
    writeFileSync(file, content);
    return spawnSync(process.execPath, [script, file], { cwd: root, encoding: 'utf8' });
  };

  it('exits 0 for a summary whose only long hex string is a commit of this repository', () => {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const result = scan(`Base \`${head}\`\n`);
    assert.equal(result.status, 0, result.stderr);
  });

  it('exits 1 and names the line when it finds a secret', () => {
    const result = scan(`fine\n${githubToken}\n`);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /line 2/);
    assert.ok(!result.stdout.includes(githubToken));
  });

  it('exits 2 when no file is given', () => {
    const result = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 2);
  });
});
