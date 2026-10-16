// `foedrum doctor`, the shell (ADR 0021): finds each tool through PATH and asks it for its
// version through the process runner. doctor.ts decides what the answers mean.

import { type ExecProcess, whyKilled } from '../platform/processes.ts';
import type { DoctorFacts, ToolName, ToolRun } from './doctor.ts';

// How each tool reports its version; socat has no --version.
const VERSION_ARGS: Readonly<Record<ToolName, readonly string[]>> = {
  npm: ['--version'],
  git: ['--version'],
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
  cwd: string;
}

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
  const [npm, git, claude, bwrap, socat, podman, docker] = await Promise.all(
    (['npm', 'git', 'claude', 'bwrap', 'socat', 'podman', 'docker'] as const).map(ask),
  );
  return {
    platform: shell.platform,
    kernelRelease: shell.kernelRelease,
    node: shell.node,
    tools: { npm, git, claude, bwrap, socat, podman, docker },
  };
};
