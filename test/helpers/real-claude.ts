import { resolveExecutable } from '../../src/platform/executables.ts';

// Tests against the installed `claude` are opt-in (ADR 0057): they depend on whichever version
// is installed, and CI, which has no `claude`, never runs them.

/** The variable that opts in, set to `1`. */
export const REAL_CLAUDE = 'FOEDRUM_REAL_CLAUDE';

/** Whether to run the tests against the installed `claude`, and which file it is. */
export type RealClaude = { kind: 'run'; claude: string } | { kind: 'skip'; reason: string };

/**
 * Runs them only when `FOEDRUM_REAL_CLAUDE=1`; otherwise skips them with a message that names
 * the variable. Opted in without `claude` on PATH throws, so the run fails instead of skipping.
 */
export const realClaude = (
  _env: NodeJS.ProcessEnv = process.env,
  _resolve: (name: string) => string | undefined = (name) => resolveExecutable(name),
): RealClaude => {
  throw new Error('not implemented');
};
