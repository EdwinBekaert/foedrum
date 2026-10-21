// `node scripts/instruction-sizes.ts [--since <commit>]`: prints the bytes and lines of every
// file of Foedrum's own instructions (CLAUDE.md, .claude/skills/, .claude/agents/, defaults/), and
// with --since the change since that commit (issue #280). instruction-sizes/core.ts decides; this
// shell reads the files and asks git (ADR 0021).

import type { Git } from '../src/workspace/git.ts';

export interface RunDeps {
  git: Git;
  /** The working directory, anywhere in the checkout. */
  cwd: string;
  /** A file's text, or undefined when it is gone from the working tree. */
  readFile: (file: string) => string | undefined;
  out: (text: string) => void;
  err: (text: string) => void;
}

export const run = async (_args: string[], _deps: RunDeps): Promise<number> => {
  throw new Error('not implemented');
};
