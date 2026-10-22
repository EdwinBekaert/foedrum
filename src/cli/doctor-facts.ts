// `foedrum doctor`, the shell (ADR 0021): finds each tool through PATH and asks it for its
// version through the process runner, and asks gh for its login and git for its credential
// helpers (ADR 0073). doctor.ts decides what the answers mean.

import { join } from 'node:path';
import type { BreweryFiles } from '../engine/recipe-files.ts';
import type { DenylistState } from '../platform/denylist.ts';
import { withoutGitHubTokens } from '../platform/env.ts';
import { type ExecProcess, whyKilled } from '../platform/processes.ts';
import {
  type CommandRun,
  type DenylistFact,
  type DoctorFacts,
  githubHostOfConfig,
  type ToolName,
  type ToolRun,
} from './doctor.ts';

// How each tool reports its version; socat has no --version.
const VERSION_ARGS: Readonly<Record<ToolName, readonly string[]>> = {
  npm: ['--version'],
  git: ['--version'],
  gh: ['--version'],
  claude: ['--version'],
  bwrap: ['--version'],
  socat: ['-V'],
  podman: ['--version'],
  docker: ['--version'],
};

// A version command answers at once; one that hangs must not hold doctor up.
const VERSION_TIMEOUT_MS = 10_000;
// A container runtime that does not answer at once is usually waiting for its daemon, and then
// not usable anyway (#99).
const CONTAINER_TIMEOUT_MS = 3_000;

const timeoutOf = (name: ToolName): number =>
  name === 'podman' || name === 'docker' ? CONTAINER_TIMEOUT_MS : VERSION_TIMEOUT_MS;

export interface DoctorShell {
  exec: ExecProcess;
  /** The file a command name runs, or `undefined` when it is not on PATH. */
  resolve: (name: string) => string | undefined;
  platform: NodeJS.Platform;
  kernelRelease: string;
  node: string;
  /** `process.execPath`: the program doctor holds in a Job Object to see that it can. */
  execPath: string;
  cwd: string;
  /** The text of the file at `path`, or undefined when there is none. */
  readFile?: (path: string) => string | undefined;
  /** The Brewery's recipe and brewer files in `cwd` (`readBreweryFiles`, ADR 0053). */
  readBrewery?: () => BreweryFiles;
  /** The local gate's personal denylist (`readDenylist`, ADR 0114); doctor keeps only its path. */
  denylist?: () => DenylistState;
  /** The environment gh runs in, without the GitHub token variables; default this process's. */
  env?: NodeJS.ProcessEnv;
  /** The GitHub host to ask gh about; default the one `foedrum.jsonc` in `cwd` names. */
  githubHost?: string;
  /** On Linux, whether AppArmor restricts unprivileged user namespaces; undefined when unknown. */
  restrictsUserns?: () => boolean | undefined;
}

// The list's state without its text: doctor never prints a word of it (ADR 0114).
const denylistFact = (state: DenylistState): DenylistFact =>
  state.kind === 'set' ? { kind: 'set', path: state.path } : state;

/** Every tool's path and version answer, asked all at once. */
export const gatherDoctorFacts = async (shell: DoctorShell): Promise<DoctorFacts> => {
  const { exec, resolve, cwd } = shell;
  const ask = async (name: ToolName): Promise<ToolRun | undefined> => {
    const path = resolve(name);
    if (path === undefined) return undefined;
    const timeoutMs = timeoutOf(name);
    const { exitCode, output, killed } = await exec(path, VERSION_ARGS[name], { cwd, timeoutMs });
    // Why the runner killed it comes first, so the report can say so.
    const why = whyKilled(killed, timeoutMs);
    return { path, exitCode, output: why === undefined ? output : `${why}\n${output}` };
  };
  // Brewers run only in a Job Object on Windows (ADR 0039): node, doing nothing, held in one.
  const holdInJob = async (): Promise<DoctorFacts['jobObject']> => {
    const timeoutMs = VERSION_TIMEOUT_MS;
    const { exitCode, output, killed } = await exec(shell.execPath, ['-e', ''], {
      cwd,
      timeoutMs,
      jobObject: true,
    });
    const why = whyKilled(killed, timeoutMs);
    return { exitCode, output: why === undefined ? output : `${why}\n${output}` };
  };
  // A foedrum.jsonc that cannot be read (a folder, no permission) is a problem doctor reports.
  let config: string | undefined;
  let configUnreadable: string | undefined;
  try {
    config = shell.readFile?.(join(cwd, 'foedrum.jsonc'));
  } catch (error) {
    configUnreadable = error instanceof Error ? error.message : String(error);
  }
  const host = shell.githubHost ?? githubHostOfConfig(config);
  // A command doctor runs besides a version command: its exit code and what it printed, why the
  // runner killed it first. `undefined` when its program is not on PATH.
  const run = async (
    name: 'gh' | 'git',
    args: readonly string[],
    env?: NodeJS.ProcessEnv,
  ): Promise<CommandRun | undefined> => {
    const path = resolve(name);
    if (path === undefined) return undefined;
    const timeoutMs = VERSION_TIMEOUT_MS;
    const ran = await exec(path, args, { cwd, timeoutMs, ...(env === undefined ? {} : { env }) });
    const why = whyKilled(ran.killed, timeoutMs);
    // gh auth status prints to stderr when there is no login; git config prints to stdout.
    const output = name === 'git' ? ran.stdout : ran.output;
    return { exitCode: ran.exitCode, output: why === undefined ? output : `${why}\n${output}` };
  };
  // As Foedrum's own calls are made: without a token variable, which gh would take instead.
  const asking = Promise.all([
    run(
      'gh',
      ['auth', 'status', '--hostname', host],
      withoutGitHubTokens(shell.env ?? process.env, shell.platform),
    ),
    run('git', ['config', '--null', '--get-regexp', '^credential\\.']),
  ]);
  const [jobObject, npm, git, gh, claude, bwrap, socat, podman, docker] = await Promise.all([
    shell.platform === 'win32' ? holdInJob() : undefined,
    ...(['npm', 'git', 'gh', 'claude', 'bwrap', 'socat', 'podman', 'docker'] as const).map(ask),
  ]);
  const [login, credentials] = await asking;
  return {
    platform: shell.platform,
    kernelRelease: shell.kernelRelease,
    node: shell.node,
    tools: { npm, git, gh, claude, bwrap, socat, podman, docker },
    github: { host, login, credentials },
    ...(jobObject === undefined ? {} : { jobObject }),
    ...(config === undefined ? {} : { config }),
    ...(configUnreadable === undefined ? {} : { configUnreadable }),
    ...(shell.readBrewery === undefined ? {} : { brewery: shell.readBrewery() }),
    ...(shell.denylist === undefined ? {} : { denylist: denylistFact(shell.denylist()) }),
  };
};
