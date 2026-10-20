// npm run demo's brewer (ADR 0097): the tests' scripted runner (test/helpers/fake-brewer-runner.ts)
// in serve's runner seam, after a fixed change committed in the attempt's worktree, so the push
// has a commit to send and no model is asked. In the life that crashes, the Cellar's process is
// killed once the commit is made, before the attempt ends.

import { devNull } from 'node:os';
import { join } from 'node:path';
import type { AttemptEnd, AttemptStart, BrewerRunner } from '../../src/engine/brewer-runner.ts';
import type { Git } from '../../src/workspace/git.ts';
import { behave, fakeBrewerRunner } from '../../test/helpers/fake-brewer-runner.ts';
import { IDENTITY, type Life } from './core.ts';

export interface ScriptedBrewerOptions {
  /** The attempt's plan, serve's own: where its worktree is. */
  plan: (start: AttemptStart) => Promise<{ cwd: string }>;
  git: Git;
  write: (path: string, text: string) => void;
  life: Life;
  /** Kills the Cellar's process; called once the commit is made, in the life that crashes. */
  crash: () => void;
  /** Called once the attempt has started, before the brewer writes; the demo shows it there. */
  started?: (ref: AttemptStart['ref']) => Promise<void>;
}

/** The file the brewer writes, and what it says. */
export const GREETING = { file: 'greeting.txt', text: 'Hello, and welcome to the Brewery.\n' };

/**
 * Who commits, for this call only: the user's own configuration (an identity, commit signing, a
 * hooks folder) takes no part in the demo.
 */
export const DEMO_GIT_CONFIG = {
  'user.name': IDENTITY.name,
  'user.email': IDENTITY.email,
  'commit.gpgsign': 'false',
  'core.hooksPath': devNull,
};

const failed = (reason: string): AttemptEnd => ({
  ending: {
    kind: 'failed',
    retryable: false,
    reason: `the demo brewer could not commit: ${reason}`,
  },
});

export const scriptedBrewer = (options: ScriptedBrewerOptions): BrewerRunner => {
  const { plan, git, write, life, crash, started } = options;
  // The tests' runner plays the attempt: a brewer that is still running when the Cellar dies, or
  // one whose out doc says done.
  const scripted = fakeBrewerRunner(() =>
    life === 'crash'
      ? behave.hang({ lastProgressAt: new Date(), turnsWithoutProgress: 0 })
      : behave.succeed(`Wrote ${GREETING.file} and committed it`),
  );
  /** The fixed change, committed in the attempt's worktree; why it could not be, if not. */
  const commit = async (start: AttemptStart): Promise<string | undefined> => {
    // Showing the attempt never fails it: the Cellar says itself why it could not.
    await started?.(start.ref).catch(() => undefined);
    try {
      const { cwd } = await plan(start);
      write(join(cwd, GREETING.file), GREETING.text);
      const steps = [
        ['add', '--', GREETING.file],
        ['commit', '-q', '-m', `Greet the visitors in ${GREETING.file}`],
      ];
      for (const args of steps) {
        const result = await git(cwd, args, { config: DEMO_GIT_CONFIG });
        if (result.code !== 0) {
          return `git ${args[0]}: ${(result.stderr || result.stdout).trim() || `exit code ${result.code}`}`;
        }
      }
      return undefined;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };
  return {
    progress: scripted.progress,
    start: (start) => {
      const run = scripted.start(start);
      // A stop while git commits (a deadline, serve's own stop) ends the attempt; no crash after it.
      let stopped = false;
      const stop = (): void => {
        stopped = true;
        run.stop();
      };
      const ended = commit(start).then((failure) => {
        if (failure !== undefined) {
          run.stop();
          return failed(failure);
        }
        if (life === 'crash' && !stopped) crash();
        return run.ended;
      });
      return { ended, stop };
    },
  };
};
