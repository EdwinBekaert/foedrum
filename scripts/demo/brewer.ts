// npm run demo's brewers (ADR 0097, ADR 0139): the Nip fixture's scripted Gauger, Cellarman and Taster
// (test/helpers/nip-fixture.ts) in serve's runner seam, as the E2E test runs them, so each attempt but the Taster's
// commits in its worktree and no model is asked. In the life that crashes, the Cellar's process is
// killed once the first attempt has committed, before that attempt ends.

import { devNull } from 'node:os';
import type { ClaudeAttemptPlan } from '../../src/brewers/claude-runner.ts';
import { attemptKey } from '../../src/engine/attempt-key.ts';
import type { AttemptEnd, AttemptStart, BrewerRunner } from '../../src/engine/brewer-runner.ts';
import type { Git } from '../../src/workspace/git.ts';
import { scriptedNip } from '../../test/helpers/nip-fixture.ts';
import { IDENTITY, type Life } from './core.ts';

export interface DemoBrewersOptions {
  /** The attempt's plan, serve's own: its worktree and its prompt. */
  plan: (start: AttemptStart) => Promise<ClaudeAttemptPlan>;
  git: Git;
  write: (path: string, text: string) => void;
  life: Life;
  /** Kills the Cellar's process; called once the commit is made, in the life that crashes. */
  crash: () => void;
  /** Called once the attempt has started, before the brewer writes; the demo shows it there. */
  started?: (ref: AttemptStart['ref']) => Promise<void>;
  /** Called with the prompt the attempt was planned with, once it has brewed. */
  brewed?: (ref: AttemptStart['ref'], prompt: string) => void;
}

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

export const demoBrewers = (options: DemoBrewersOptions): BrewerRunner => {
  const { life, crash, started, brewed } = options;
  const nip = scriptedNip({ ...options, config: DEMO_GIT_CONFIG });
  return {
    progress: nip.progress,
    start: (start) => {
      let run: ReturnType<BrewerRunner['start']> | undefined;
      // A stop (a deadline, serve's own stop) ends the attempt; no crash after it.
      let stopped = false;
      const ended = (async (): Promise<AttemptEnd> => {
        // Showing the attempt never fails it: the Cellar says itself why it could not.
        await started?.(start.ref).catch(() => undefined);
        if (stopped) return { ending: { kind: 'cancelled' } };
        run = nip.start(start);
        const end = await run.ended;
        brewed?.(start.ref, nip.prompts.get(attemptKey.encode(start.ref)) ?? '');
        if (life !== 'crash' || stopped || end.ending.kind !== 'succeeded') return end;
        crash();
        // The process dies with the attempt still running.
        return new Promise<never>(() => {});
      })();
      return {
        ended,
        stop: () => {
          stopped = true;
          run?.stop();
        },
      };
    },
  };
};
