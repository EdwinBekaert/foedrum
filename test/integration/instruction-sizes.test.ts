// Real git for `node scripts/instruction-sizes.ts` (issue #280): the files git lists in the working
// tree and at an earlier commit, through the command lines the unit tests answer by hand.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { removeTree } from '../../src/platform/remove.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';

const script = join(import.meta.dirname, '..', '..', 'scripts', 'instruction-sizes.ts');

describe('instruction-sizes with real git', () => {
  let dir: TempDir;
  let repo: string;
  // Only the fixture's own git config: no hooks path, excludes file or signing from the machine.
  let env: NodeJS.ProcessEnv;
  const git = (cwd: string, args: string[]): string =>
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=t@example.com', ...args], {
      cwd,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    });
  const write = (file: string, text: string) => {
    mkdirSync(dirname(join(repo, file)), { recursive: true });
    writeFileSync(join(repo, file), text);
  };
  beforeEach(() => {
    dir = makeTempDir('instruction-sizes');
    repo = join(dir.path, 'repo');
    writeFileSync(join(dir.path, 'gitconfig'), '');
    env = {
      ...process.env,
      GIT_CONFIG_GLOBAL: join(dir.path, 'gitconfig'),
      GIT_CONFIG_NOSYSTEM: '1',
    };
    git(dir.path, ['init', '-q', '-b', 'main', repo]);
    write('.gitignore', 'defaults/ignored.md\n');
    write('CLAUDE.md', 'a\nb\n');
    write('.claude/rules/gate.md', 'r\n');
    write('.claude/settings.json', '{}\n');
    write('defaults/.gitkeep', '');
    write('defaults/old.md', 'x\n');
    write('src/a.ts', 'export {};\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'Initial commit']);
  });
  afterEach(() => removeTree(dir.path));

  it('prints the working tree against the commit, with new, removed and ignored files', () => {
    write('CLAUDE.md', 'a\nb\nc\n');
    rmSync(join(repo, 'defaults', 'old.md'));
    write('defaults/new.md', 'n\n');
    write('defaults/ignored.md', 'i\n');
    const sha = git(repo, ['rev-parse', 'HEAD']).trim();

    const result = spawnSync(process.execPath, [script, '--since', 'HEAD'], {
      cwd: join(repo, 'src'),
      env,
      encoding: 'utf8',
      timeout: 60_000,
    });

    assert.equal(result.status, 0, result.stderr);
    const since = sha.slice(0, 12);
    assert.deepEqual(result.stdout.split('\n'), [
      `file\tbytes\tlines\tbytes since ${since}\tlines since ${since}`,
      '.claude/rules/gate.md\t2\t1\t0\t0',
      'CLAUDE.md\t6\t3\t+2\t+1',
      'defaults/new.md\t2\t1\tnew\tnew',
      'defaults/old.md\t-\t-\t-2\t-1',
      'total\t10\t5\t+2\t+1',
      '',
    ]);
  });
});
