// `node scripts/affected-tests.ts`: lists the test files the change reaches (ADR 0241), the ones
// `npm run check` runs. The change is the files that differ between the merge base of HEAD with
// origin/main and the working tree, untracked files included. affected-tests/core.ts decides;
// this shell asks git and reads the files (ADR 0021).

import { join } from 'node:path';
import type { OkGit } from '../src/workspace/worktree-removal-git.ts';
import { type Affected, affectedTests } from './affected-tests/core.ts';

export interface ChangeOptions {
  // The checkout's root; git's paths are relative to it.
  cwd: string;
  git: OkGit;
  // A file's text by its absolute path; undefined when it is not there.
  read: (path: string) => Promise<string | undefined>;
}

const paths = (stdout: string): string[] => stdout.split('\0').filter((path) => path !== '');

// The output of a git call, or an error naming it and git's first line when it failed.
const output = async (git: OkGit, cwd: string, args: string[]): Promise<string> => {
  const { ok, stdout, stderr } = await git(cwd, args);
  if (!ok) throw new Error(`git ${args[0]} failed: ${stderr.split(/\r?\n/)[0] ?? ''}`);
  return stdout;
};

/** The test files the change in the checkout at cwd reaches. */
export const affectedByChange = async ({ cwd, git, read }: ChangeOptions): Promise<Affected> => {
  const base = await git(cwd, ['merge-base', 'HEAD', 'origin/main']);
  if (!base.ok) {
    return {
      kind: 'all',
      why: `no merge base with origin/main: ${base.stderr.split(/\r?\n/)[0] ?? ''}`,
    };
  }
  try {
    const [changed, untracked, typescript] = await Promise.all([
      output(git, cwd, ['diff', '--name-only', '--no-renames', '-z', base.stdout.trim()]),
      output(git, cwd, ['ls-files', '-z', '--others', '--exclude-standard']),
      output(git, cwd, [
        'ls-files',
        '-z',
        '--cached',
        '--others',
        '--exclude-standard',
        '--',
        '*.ts',
      ]),
    ]);
    // A file listed but gone from the working tree (deleted, not staged) is left out.
    const texts = new Map<string, string>();
    await Promise.all(
      paths(typescript).map(async (path) => {
        const text = await read(join(cwd, path));
        if (text !== undefined) texts.set(path, text);
      }),
    );
    return affectedTests([...paths(changed), ...paths(untracked)], texts);
  } catch (error) {
    return { kind: 'all', why: error instanceof Error ? error.message : String(error) };
  }
};

if (import.meta.main) {
  const { readFile } = await import('node:fs/promises');
  const { gitThrough } = await import('../src/workspace/worktree-removal-git.ts');
  const { runGit } = await import('../src/workspace/git.ts');
  const affected = await affectedByChange({
    cwd: process.cwd(),
    git: gitThrough(runGit),
    read: (path) => readFile(path, 'utf8').catch(() => undefined),
  });
  process.stdout.write(
    affected.kind === 'all'
      ? `every test file: ${affected.why}\n`
      : affected.files.map((file) => `${file}\n`).join(''),
  );
}
