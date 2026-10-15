// scripts/secret-scan.ts with real node and git (ADR 0021): reading the file and asking git
// whether a hash is a commit. Matching and exit codes are unit tests in
// test/unit/secret-scan.test.ts.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';

const root = join(import.meta.dirname, '..', '..');
const script = join(root, 'scripts', 'secret-scan.ts');

// Built at run time so the source never holds a token-shaped string.
const githubToken = `ghp${'_'}${'a1B2'.repeat(9)}`;

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
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });

  it('exits 1 for a long hex string that git does not know as a commit', () => {
    const result = scan(`Base \`${'c0ffee'.repeat(6)}beef\`\n`);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /^line 1: long hexadecimal string/);
  });

  it('exits 1 and names the line when it finds a secret', () => {
    const result = scan(`fine\n${githubToken}\n`);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /^line 2: GitHub token/);
    assert.ok(!result.stdout.includes(githubToken));
  });
});
