// The shell of scripts/affected-tests.ts, with git and the file reads injected (ADR 0021).

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { affectedByChange } from '../../scripts/affected-tests.ts';
import type { OkGit, OkGitResult } from '../../src/workspace/worktree-removal-git.ts';

const cwd = join('/work', 'tree');
const base = 'b'.repeat(40);
const ok = (stdout: string): OkGitResult => ({ ok: true, stdout, stderr: '' });
const z = (...paths: string[]): string => paths.map((path) => `${path}\0`).join('');

// git answering each command by its arguments; an unexpected command fails the test.
const fakeGit = (answers: Record<string, OkGitResult>) => {
  const calls: string[] = [];
  const git: OkGit = async (where, args) => {
    assert.equal(where, cwd);
    const key = args.join(' ');
    calls.push(key);
    const answer = answers[key];
    assert.ok(answer, `unexpected git ${key}`);
    return answer;
  };
  return { git, calls };
};

const MERGE_BASE = 'merge-base HEAD origin/main';
const DIFF = `diff --name-only --no-renames -z ${base}`;
const UNTRACKED = 'ls-files -z --others --exclude-standard';
const TYPESCRIPT = 'ls-files -z --cached --others --exclude-standard -- *.ts';

const files: Record<string, string> = {
  'src/cli/format.ts': 'export const format = 1;\n',
  'src/cli/status.ts': "import './format.ts';\n",
  'test/unit/status.test.ts': "import '../../src/cli/status.ts';\n",
  'test/unit/new.test.ts': "import '../../src/cli/new.ts';\n",
  'src/cli/new.ts': '',
};
const read = async (path: string): Promise<string | undefined> =>
  Object.entries(files).find(([name]) => join(cwd, name) === path)?.[1];

describe('affectedByChange', () => {
  it('reaches the test files of the files changed since the merge base, untracked ones included', async () => {
    const { git, calls } = fakeGit({
      [MERGE_BASE]: ok(`${base}\n`),
      [DIFF]: ok(z('src/cli/format.ts')),
      [UNTRACKED]: ok(z('src/cli/new.ts', 'test/unit/new.test.ts')),
      [TYPESCRIPT]: ok(z(...Object.keys(files), 'src/cli/gone.ts')),
    });
    assert.deepEqual(await affectedByChange({ cwd, git, read }), {
      kind: 'some',
      files: ['test/unit/new.test.ts', 'test/unit/status.test.ts'],
    });
    assert.deepEqual(calls.slice(0, 1), [MERGE_BASE]);
  });

  it('runs every test file, saying why, when there is no merge base with origin/main', async () => {
    const { git } = fakeGit({
      [MERGE_BASE]: {
        ok: false,
        stdout: '',
        stderr: 'fatal: Not a valid object name origin/main\n',
      },
    });
    const affected = await affectedByChange({ cwd, git, read });
    assert.equal(affected.kind, 'all');
    assert.match(
      (affected as { why: string }).why,
      /no merge base with origin\/main: fatal: Not a valid object name origin\/main/,
    );
  });

  it('runs every test file, saying why, when a git call fails', async () => {
    const { git } = fakeGit({
      [MERGE_BASE]: ok(`${base}\n`),
      [DIFF]: { ok: false, stdout: '', stderr: 'fatal: bad object\n' },
      [UNTRACKED]: ok(''),
      [TYPESCRIPT]: ok(''),
    });
    const affected = await affectedByChange({ cwd, git, read });
    assert.equal(affected.kind, 'all');
    assert.match((affected as { why: string }).why, /git diff failed: fatal: bad object/);
  });
});
