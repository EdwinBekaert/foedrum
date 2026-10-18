// doctor and serve on this machine, with gh's login check answered from captured output (ADR
// 0073): what doctor does with gh's answer is the unit tests' (captured gh output), and whether
// `gh auth status` works is gh's business. So the real runner starts every other tool, and no
// test asks the real gh for a login, reaches github.com or touches the keyring.

import { existsSync, readFileSync } from 'node:fs';
import { release } from 'node:os';
import { diagnose, formatDiagnosis } from '../../src/cli/doctor.ts';
import { type DoctorShell, gatherDoctorFacts } from '../../src/cli/doctor-facts.ts';
import { readBreweryFiles } from '../../src/engine/brewery-files.ts';
import { resolveExecutable } from '../../src/platform/executables.ts';
import { type ExecProcess, execProcess } from '../../src/platform/processes.ts';

/** A host no real account logs in to: the one the canned answers name. */
export const MADE_UP_HOST = 'ghe.example';

/** What gh 2.102.0 printed for a host it was logged in to, the token line left out. */
const loggedIn = (host: string): string =>
  `${host}\n  ✓ Logged in to ${host} account brewer (keyring)\n  - Active account: true\n  - Git operations protocol: https\n`;

/**
 * `exec`, except that `gh auth status --hostname <host>` answers that gh is logged in to that host
 * without starting gh; `version`, when given, is what `gh --version` answers instead of gh.
 */
export const cannedGhLogin =
  (exec: ExecProcess = execProcess, version?: string): ExecProcess =>
  async (file, args, options) => {
    if (args[0] === 'auth' && args[1] === 'status') {
      const output = loggedIn(args[3] ?? MADE_UP_HOST);
      return { exitCode: 0, stdout: output, stderr: '', output };
    }
    if (version !== undefined && args[0] === '--version' && /\bgh(?:\.exe)?$/i.test(file)) {
      return { exitCode: 0, stdout: version, stderr: '', output: version };
    }
    return exec(file, args, options);
  };

/**
 * `foedrum doctor` in `cwd` as its command runs it (the facts, the diagnosis and the report),
 * on this machine but for gh's login check, asked about `MADE_UP_HOST` unless `shell` says.
 */
export const doctorHere = async (
  cwd: string,
  shell: Partial<DoctorShell> = {},
): Promise<{ exitCode: number; stdout: string }> => {
  const diagnosis = diagnose(
    await gatherDoctorFacts({
      exec: cannedGhLogin(),
      resolve: resolveExecutable,
      platform: process.platform,
      kernelRelease: release(),
      node: process.versions.node,
      execPath: process.execPath,
      cwd,
      readFile: (path) => (existsSync(path) ? readFileSync(path, 'utf8') : undefined),
      readBrewery: () => readBreweryFiles(cwd),
      githubHost: MADE_UP_HOST,
      ...shell,
    }),
  );
  return { exitCode: diagnosis.ok ? 0 : 1, stdout: formatDiagnosis(diagnosis) };
};
