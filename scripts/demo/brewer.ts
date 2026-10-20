// npm run demo's brewer (ADR 0097): the tests' scripted runner (test/helpers/fake-brewer-runner.ts)
// in serve's runner seam, after a fixed change committed in the attempt's worktree, so the push
// has a commit to send and no model is asked. In the life that crashes, the Cellar's process is
// killed once the commit is made, before the attempt ends.

import type { AttemptStart, BrewerRunner } from '../../src/engine/brewer-runner.ts';
import type { Git } from '../../src/workspace/git.ts';
import type { Life } from './core.ts';

export interface ScriptedBrewerOptions {
  /** The attempt's plan, serve's own: where its worktree is. */
  plan: (start: AttemptStart) => Promise<{ cwd: string }>;
  git: Git;
  write: (path: string, text: string) => void;
  life: Life;
  /** Kills the Cellar's process; called once the commit is made, in the life that crashes. */
  crash: () => void;
}

/** The file the brewer writes, and what it says. */
export const GREETING = { file: 'greeting.txt', text: 'Hello, and welcome to the Brewery.\n' };

export const scriptedBrewer = (_options: ScriptedBrewerOptions): BrewerRunner => {
  throw new Error('not implemented');
};
