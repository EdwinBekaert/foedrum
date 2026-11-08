// `foedrum recipe`'s effects on the real machine (ADR 0355): serve's setup of the Brewery in the
// working directory and serve's shell, under an owner of its own. cli-main.ts runs it once the
// choice is recorded; the logic is apply-effects.ts's, tested with fakes.

import { runGit } from '../workspace/git.ts';
import { later, runApplyEffects } from './apply-effects.ts';
import { type StartOptions, serveSetupIn } from './serve-main.ts';
import { listenWhileServing, serveShell } from './serve-shell.ts';

/** Applies the due effects of `batchId` from the Brewery checkout `cwd`; the lines to say. */
export const applyEffectsFromCheckout = async (
  cwd: string,
  batchId: string,
  options?: StartOptions,
): Promise<string[]> => {
  const ready = await serveSetupIn(cwd, options);
  if (ready.kind === 'refused') return ready.problems.map(later);
  const { setup } = ready;
  // The stop signals are listened for while the effects go out, and no longer once they did.
  const listening = listenWhileServing(process);
  try {
    const shell = serveShell(setup, {
      root: cwd,
      git: runGit,
      out: (line) => process.stdout.write(`${line}\n`),
      listen: listening.listen,
      command: 'recipe',
    });
    return await runApplyEffects(setup, shell, { batchId, owner: `recipe-${process.pid}` });
  } finally {
    listening.stop();
  }
};
