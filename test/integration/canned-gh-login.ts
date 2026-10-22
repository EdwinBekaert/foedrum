// doctor and serve on this machine, with gh answered from captured output (ADR 0073): what doctor
// does with gh's answers is the unit tests' (captured gh output), and whether gh works, and how fast
// it starts, is gh's business (ADR 0070). So gh is found at a made-up path and never started; the
// real runner starts every other tool, and no test asks the real gh for a login, reaches
// github.com or touches the keyring.

import { parse } from 'node:path';
import { doctorFromCheckout } from '../../src/cli/doctor-main.ts';
import { runCli } from '../../src/cli/run.ts';
import type { DenylistState } from '../../src/platform/denylist.ts';
import { resolveExecutable } from '../../src/platform/executables.ts';
import { type ExecProcess, execProcess } from '../../src/platform/processes.ts';

/** A host no real account logs in to: the only one the canned answer is logged in to. */
export const MADE_UP_HOST = 'ghe.example';

/** A foedrum.jsonc whose GitHub is `MADE_UP_HOST`. */
export const MADE_UP_CONFIG = JSON.stringify({
  repositories: {},
  githubApi: `https://${MADE_UP_HOST}/api/v3`,
});

/** Where the tests' PATH lookup finds gh: no file is there, and nothing starts it. */
export const MADE_UP_GH = '/made-up/bin/gh';

/** The version the canned `gh --version` answers: above doctor's minimum, and no gh's release. */
export const CANNED_GH_VERSION = '9999.0.0';

/** The PATH lookup, but gh is `MADE_UP_GH`, whether this machine has a gh or not. */
export const resolveWithMadeUpGh = (name: string): string | undefined =>
  name === 'gh' ? MADE_UP_GH : resolveExecutable(name);

/** No denylist, so doctor never reads the user's own (ADR 0114). */
export const noDenylist = (): DenylistState => ({ kind: 'none', path: '/made-up/denylist.txt' });

// gh's version answer is made up on purpose: gh 2.102.0's two lines with a version and date no
// release has, so a row that shows it proves the canned answer was used. The login answers are
// what gh 2.102.0 printed for a host it was logged in to (the token line left out), and with no
// login at all.
export const GH_VERSION_ANSWER = `gh version ${CANNED_GH_VERSION} (9999-01-01)\nhttps://github.com/cli/cli/releases/tag/v${CANNED_GH_VERSION}\n`;
export const GH_LOGGED_IN_ANSWER = `${MADE_UP_HOST}\n  ✓ Logged in to ${MADE_UP_HOST} account brewer (keyring)\n  - Active account: true\n  - Git operations protocol: https\n`;
export const GH_NO_LOGIN_ANSWER =
  'You are not logged into any GitHub hosts. To log in, run: gh auth login\n';

// gh by its name, whatever the extension PATHEXT gave it (gh.exe, gh.cmd, gh.bat).
const isGh = (file: string): boolean => parse(file).name.toLowerCase() === 'gh';

/**
 * `exec`, except that gh answers from captured output without starting: `gh --version` with
 * `CANNED_GH_VERSION`, and `gh auth status` logged in for `--hostname <MADE_UP_HOST>`, with no
 * login for anything else.
 */
export const cannedGhLogin =
  (exec: ExecProcess = execProcess): ExecProcess =>
  async (file, args, options) => {
    if (!isGh(file)) return exec(file, args, options);
    if (args.join(' ') === '--version') {
      return { exitCode: 0, stdout: GH_VERSION_ANSWER, stderr: '', output: GH_VERSION_ANSWER };
    }
    if (args[0] === 'auth' && args[1] === 'status') {
      return args.join(' ') === `auth status --hostname ${MADE_UP_HOST}`
        ? { exitCode: 0, stdout: GH_LOGGED_IN_ANSWER, stderr: '', output: GH_LOGGED_IN_ANSWER }
        : { exitCode: 1, stdout: '', stderr: GH_NO_LOGIN_ANSWER, output: GH_NO_LOGIN_ANSWER };
    }
    throw new Error(`gh ${args.join(' ')} has no canned answer`);
  };

const notForDoctor = (what: string) => () => {
  throw new Error(`foedrum doctor uses no ${what}`);
};

/**
 * `foedrum doctor` in `cwd` through the command layer (`runCli`), with the facts main.ts gathers
 * (`doctorFromCheckout`) through `exec`, default the real runner with canned gh, and the tools
 * `resolve` finds, default gh at `MADE_UP_GH`.
 */
export const doctorHere = async (
  cwd: string,
  exec: ExecProcess = cannedGhLogin(),
  resolve: (name: string) => string | undefined = resolveWithMadeUpGh,
) =>
  runCli(['doctor'], {
    cwd,
    gatherDoctorFacts: () => doctorFromCheckout(cwd, { exec, resolve, denylist: noDenylist }),
    openStore: notForDoctor('store'),
    openWritableStore: notForDoctor('store'),
    recipes: notForDoctor('recipes'),
    user: () => 'doctor-test',
    surface: 'terminal',
    now: () => new Date(),
    readKeptBranches: notForDoctor('kept branches'),
    config: notForDoctor('foedrum.jsonc'),
    claims: notForDoctor('claims'),
    serve: notForDoctor('serve'),
  });
