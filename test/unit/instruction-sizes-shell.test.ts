import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { run } from '../../scripts/instruction-sizes.ts';
import type { GitResult } from '../../src/workspace/git.ts';

const ROOT = join('checkout');
const SHA = '0123456789abcdef0123456789abcdef01234567';
const SCOPE = ['--', 'CLAUDE.md', '.claude/rules', '.claude/skills', '.claude/agents', 'defaults'];

const ok = (stdout: string): GitResult => ({ code: 0, stdout, stderr: '' });

// git's answers by command line; a command it does not know fails as git would.
const runWith = async (
  args: string[],
  answers: Record<string, GitResult>,
  files: Record<string, string>,
) => {
  const out: string[] = [];
  const err: string[] = [];
  const calls: string[] = [];
  const code = await run(args, {
    git: async (cwd, gitArgs) => {
      calls.push(`${cwd}: ${gitArgs.join(' ')}`);
      return answers[gitArgs.join(' ')] ?? { code: 128, stdout: '', stderr: 'fatal: unknown\n' };
    },
    cwd: join(ROOT, 'src'),
    readFile: (file) => files[file],
    out: (text) => out.push(text),
    err: (text) => err.push(text),
  });
  return { code, out: out.join(''), err: err.join(''), calls };
};

const TOPLEVEL = { 'rev-parse --show-toplevel': ok(`${ROOT}\n`) };
const LS_FILES = ['ls-files', '-z', '--cached', '--others', '--exclude-standard', ...SCOPE].join(
  ' ',
);

describe('node scripts/instruction-sizes.ts', () => {
  it('prints the size of every audited file in the working tree', async () => {
    const result = await runWith(
      [],
      {
        ...TOPLEVEL,
        [LS_FILES]: ok('CLAUDE.md\0defaults/.gitkeep\0defaults/gone.md\0defaults/a.md\0'),
      },
      { [join(ROOT, 'CLAUDE.md')]: 'a\nb\n', [join(ROOT, 'defaults/a.md')]: 'xyz' },
    );
    assert.deepEqual(
      { code: result.code, out: result.out, err: result.err },
      {
        code: 0,
        out: 'file\tbytes\tlines\nCLAUDE.md\t4\t2\ndefaults/a.md\t3\t1\ntotal\t7\t3\n',
        err: '',
      },
    );
    assert.ok(
      result.calls.every(
        (call) =>
          call.startsWith(`${join(ROOT, 'src')}: rev-parse`) || call.startsWith(`${ROOT}: `),
      ),
    );
  });

  it('with --since, adds the change since that commit, read from git', async () => {
    const result = await runWith(
      ['--since', 'v0.1'],
      {
        ...TOPLEVEL,
        [LS_FILES]: ok('CLAUDE.md\0defaults/new.md\0'),
        'rev-parse --verify --quiet --end-of-options v0.1^{commit}': ok(`${SHA}\n`),
        [['ls-tree', '-r', '-z', '--name-only', SHA, ...SCOPE].join(' ')]: ok(
          'CLAUDE.md\0defaults/.gitkeep\0defaults/old.md\0',
        ),
        [`cat-file blob ${SHA}:CLAUDE.md`]: ok('a\n'),
        [`cat-file blob ${SHA}:defaults/old.md`]: ok('old\nfile\n'),
      },
      { [join(ROOT, 'CLAUDE.md')]: 'a\nb\n', [join(ROOT, 'defaults/new.md')]: 'n\n' },
    );
    assert.deepEqual(
      { code: result.code, out: result.out.split('\n'), err: result.err },
      {
        code: 0,
        out: [
          'file\tbytes\tlines\tbytes since 0123456789ab\tlines since 0123456789ab',
          'CLAUDE.md\t4\t2\t+2\t+1',
          'defaults/new.md\t2\t1\tnew\tnew',
          'defaults/old.md\t-\t-\t-9\t-2',
          'total\t6\t3\t-5\t0',
          '',
        ],
        err: '',
      },
    );
  });

  it('refuses a --since that is not a commit, and exits 1', async () => {
    const result = await runWith(['--since', 'nope'], { ...TOPLEVEL, [LS_FILES]: ok('') }, {});
    assert.deepEqual(
      { code: result.code, out: result.out, err: result.err },
      { code: 1, out: '', err: 'nope is not a commit\n' },
    );
  });

  it('exits 1 with git error when git cannot list the files', async () => {
    const result = await runWith([], { ...TOPLEVEL }, {});
    assert.deepEqual(
      { code: result.code, out: result.out, err: result.err },
      { code: 1, out: '', err: 'git ls-files failed: fatal: unknown\n' },
    );
  });

  it('counts a file git lists twice once, as during a merge conflict', async () => {
    const result = await runWith(
      [],
      { ...TOPLEVEL, [LS_FILES]: ok('CLAUDE.md\0CLAUDE.md\0') },
      { [join(ROOT, 'CLAUDE.md')]: 'a\n' },
    );
    assert.equal(result.out, 'file\tbytes\tlines\nCLAUDE.md\t2\t1\ntotal\t2\t1\n');
  });

  it('exits 1 with the git error when git cannot read the earlier commit', async () => {
    const since = {
      ...TOPLEVEL,
      [LS_FILES]: ok('CLAUDE.md\0'),
      'rev-parse --verify --quiet --end-of-options v0.1^{commit}': ok(`${SHA}\n`),
    };
    const files = { [join(ROOT, 'CLAUDE.md')]: 'a\n' };
    const noTree = await runWith(['--since', 'v0.1'], since, files);
    assert.deepEqual(
      { code: noTree.code, out: noTree.out, err: noTree.err },
      { code: 1, out: '', err: 'git ls-tree failed: fatal: unknown\n' },
    );
    const noBlob = await runWith(
      ['--since', 'v0.1'],
      {
        ...since,
        [['ls-tree', '-r', '-z', '--name-only', SHA, ...SCOPE].join(' ')]: ok('CLAUDE.md\0'),
      },
      files,
    );
    assert.deepEqual(
      { code: noBlob.code, out: noBlob.out, err: noBlob.err },
      { code: 1, out: '', err: 'git cat-file failed: fatal: unknown\n' },
    );
  });

  it('exits 1 outside a checkout', async () => {
    const result = await runWith([], {}, {});
    assert.deepEqual(
      { code: result.code, out: result.out, err: result.err },
      { code: 1, out: '', err: 'git rev-parse failed: fatal: unknown\n' },
    );
  });

  it('exits 2 with the usage on an unknown option or an argument', async () => {
    for (const args of [['--until', 'x'], ['CLAUDE.md'], ['--since']]) {
      const result = await runWith(args, TOPLEVEL, {});
      assert.deepEqual(
        { code: result.code, out: result.out, err: result.err },
        { code: 2, out: '', err: 'usage: node scripts/instruction-sizes.ts [--since <commit>]\n' },
        args.join(' '),
      );
    }
  });
});
