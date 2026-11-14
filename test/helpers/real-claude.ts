import { resolveExecutable } from '../../src/platform/executables.ts';

// Tests against the installed `claude` are opt-in (ADR 0057): they depend on whichever version
// is installed. CI's real-claude job opts in with the claude pinned in ci/claude/ (ADR 0399).

/** The variable that opts in, set to `1`. */
export const REAL_CLAUDE = 'FOEDRUM_REAL_CLAUDE';

/** Whether to run the tests against the installed `claude`, and which file it is. */
export type RealClaude = { kind: 'run'; claude: string } | { kind: 'skip'; reason: string };

/**
 * Runs them only when `FOEDRUM_REAL_CLAUDE=1`; otherwise skips them with a message that names
 * the variable. Opted in without `claude` on PATH throws, so the run fails instead of skipping.
 */
export const realClaude = (
  env: NodeJS.ProcessEnv = process.env,
  resolve: (name: string) => string | undefined = resolveExecutable,
): RealClaude => {
  if (env[REAL_CLAUDE] !== '1') {
    return {
      kind: 'skip',
      reason: `set ${REAL_CLAUDE}=1 to run the tests against the installed claude`,
    };
  }
  const claude = resolve('claude');
  if (claude === undefined) {
    throw new Error(`${REAL_CLAUDE}=1 is set, but claude is not on PATH`);
  }
  return { kind: 'run', claude };
};
