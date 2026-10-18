// An environment for a real `foedrum` process whose gh has no login (ADR 0073): doctor and serve
// ask `gh auth status`, which checks a login against GitHub; with an empty configuration folder
// of its own, gh has none to check, so no test reaches github.com or the user's login.

import { join } from 'node:path';
import { withoutGitHubTokens } from '../../src/platform/env.ts';

/** This process's environment, without a token variable and with gh's configuration in `dir`. */
export const envWithoutGhLogin = (dir: string): NodeJS.ProcessEnv => ({
  ...withoutGitHubTokens(process.env, process.platform),
  GH_CONFIG_DIR: join(dir, '.gh-config'),
});
