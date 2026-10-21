// `node scripts/instruction-sizes.ts [--since <commit>]`: prints the bytes and lines of every
// file of Foedrum's own instructions (CLAUDE.md, .claude/skills/, .claude/agents/, defaults/), and
// with --since the change since that commit (issue #280). instruction-sizes/core.ts decides; this
// shell reads the files and asks git (ADR 0021).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { type Git, runGit } from '../src/workspace/git.ts';
import {
  AUDITED_PATHS,
  compare,
  formatReport,
  isAudited,
  measure,
  type Size,
} from './instruction-sizes/core.ts';

export interface RunDeps {
  git: Git;
  /** The working directory, anywhere in the checkout. */
  cwd: string;
  /** A file's text, or undefined when it is gone from the working tree. */
  readFile: (file: string) => string | undefined;
  out: (text: string) => void;
  err: (text: string) => void;
}

const USAGE = 'usage: node scripts/instruction-sizes.ts [--since <commit>]\n';
const SCOPE = ['--', ...AUDITED_PATHS];

class GitFailed extends Error {}

// git's output, or GitFailed with the command and the first line of what git said.
const gitOut = async (git: Git, cwd: string, args: string[]): Promise<string> => {
  const result = await git(cwd, args);
  if (result.code === 0) return result.stdout;
  const [first = ''] = result.stderr.trim().split('\n');
  throw new GitFailed(`git ${args[0]} failed: ${first.trim()}`);
};

const audited = (zList: string): string[] => [
  ...new Set(zList.split('\0').filter((file) => file !== '' && isAudited(file))),
];

const sizesNow = async (deps: RunDeps, root: string): Promise<Record<string, Size>> => {
  const listed = await gitOut(deps.git, root, [
    'ls-files',
    '-z',
    '--cached',
    '--others',
    '--exclude-standard',
    ...SCOPE,
  ]);
  const sizes: Record<string, Size> = {};
  for (const file of audited(listed)) {
    // A tracked file deleted from the working tree is gone, not empty.
    const text = deps.readFile(join(root, file));
    if (text !== undefined) sizes[file] = measure(text);
  }
  return sizes;
};

const sizesAt = async (git: Git, root: string, sha: string): Promise<Record<string, Size>> => {
  const listed = await gitOut(git, root, ['ls-tree', '-r', '-z', '--name-only', sha, ...SCOPE]);
  const sizes: Record<string, Size> = {};
  for (const file of audited(listed)) {
    sizes[file] = measure(await gitOut(git, root, ['cat-file', 'blob', `${sha}:${file}`]));
  }
  return sizes;
};

// The command without the process: the exit code for these arguments.
export const run = async (args: string[], deps: RunDeps): Promise<number> => {
  let since: string | undefined;
  try {
    ({ since } = parseArgs({ args, options: { since: { type: 'string' } } }).values);
  } catch {
    deps.err(USAGE);
    return 2;
  }
  try {
    const root = (await gitOut(deps.git, deps.cwd, ['rev-parse', '--show-toplevel'])).trim();
    const now = await sizesNow(deps, root);
    if (since === undefined) {
      for (const line of formatReport(compare(now))) deps.out(`${line}\n`);
      return 0;
    }
    const resolved = await deps.git(root, [
      'rev-parse',
      '--verify',
      '--quiet',
      '--end-of-options',
      `${since}^{commit}`,
    ]);
    if (resolved.code !== 0) {
      deps.err(`${since} is not a commit\n`);
      return 1;
    }
    const sha = resolved.stdout.trim();
    const before = await sizesAt(deps.git, root, sha);
    for (const line of formatReport(compare(now, before), sha.slice(0, 12))) deps.out(`${line}\n`);
    return 0;
  } catch (error) {
    if (!(error instanceof GitFailed)) throw error;
    deps.err(`${error.message}\n`);
    return 1;
  }
};

if (import.meta.main) {
  process.exitCode = await run(process.argv.slice(2), {
    git: runGit,
    cwd: process.cwd(),
    readFile: (file) => {
      try {
        return readFileSync(file, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
    },
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
  });
}
