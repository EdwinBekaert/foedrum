// doctor and serve on this machine, with gh's login check answered from captured output (ADR
// 0073): what doctor does with gh's answer is the unit tests' (captured gh output), and whether
// `gh auth status` works is gh's business. So the real runner starts every other tool, and no
// test asks the real gh for a login, reaches github.com or touches the keyring.

import { doctorFromCheckout } from '../../src/cli/doctor-main.ts';
import { runCli } from '../../src/cli/run.ts';
import { type ExecProcess, execProcess } from '../../src/platform/processes.ts';

/** A host no real account logs in to: the only one the canned answer is logged in to. */
export const MADE_UP_HOST = 'ghe.example';

/** A foedrum.jsonc whose GitHub is `MADE_UP_HOST`. */
export const MADE_UP_CONFIG = JSON.stringify({
  repositories: {},
  githubApi: `https://${MADE_UP_HOST}/api/v3`,
});

// What gh 2.102.0 printed for a host it was logged in to (the token line left out), and with no
// login at all.
const LOGGED_IN = `${MADE_UP_HOST}\n  ✓ Logged in to ${MADE_UP_HOST} account brewer (keyring)\n  - Active account: true\n  - Git operations protocol: https\n`;
const NO_LOGIN = 'You are not logged into any GitHub hosts. To log in, run: gh auth login\n';

/**
 * `exec`, except that `gh auth status` answers from captured output without starting gh: logged in
 * for `gh auth status --hostname <MADE_UP_HOST>`, no login for anything else. `version`, when given,
 * is what `gh --version` answers instead of gh.
 */
export const cannedGhLogin =
  (exec: ExecProcess = execProcess, version?: string): ExecProcess =>
  async (file, args, options) => {
    if (args[0] === 'auth' && args[1] === 'status') {
      return args.join(' ') === `auth status --hostname ${MADE_UP_HOST}`
        ? { exitCode: 0, stdout: LOGGED_IN, stderr: '', output: LOGGED_IN }
        : { exitCode: 1, stdout: '', stderr: NO_LOGIN, output: NO_LOGIN };
    }
    if (version !== undefined && args[0] === '--version' && /\bgh(?:\.exe)?$/i.test(file)) {
      return { exitCode: 0, stdout: version, stderr: '', output: version };
    }
    return exec(file, args, options);
  };

const notForDoctor = (what: string) => () => {
  throw new Error(`foedrum doctor uses no ${what}`);
};

/**
 * `foedrum doctor` in `cwd` through the command layer (`runCli`), with the facts main.ts gathers
 * (`doctorFromCheckout`) through `exec`: default the real runner with the canned login.
 */
export const doctorHere = async (cwd: string, exec: ExecProcess = cannedGhLogin()) =>
  runCli(['doctor'], {
    cwd,
    gatherDoctorFacts: () => doctorFromCheckout(cwd, { exec }),
    openStore: notForDoctor('store'),
    openWritableStore: notForDoctor('store'),
    recipes: notForDoctor('recipes'),
    user: () => 'doctor-test',
    surface: 'terminal',
    now: () => new Date(),
    serve: notForDoctor('serve'),
  });
