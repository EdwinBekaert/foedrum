// Facts `foedrum doctor` gathers, for its core and the CLI's snapshot tests: fixed paths and
// versions, so the reports are the same on every platform.

import type { DoctorFacts, ToolName, ToolRun } from '../../src/cli/doctor.ts';

export const ran = (path: string, output: string, exitCode: number | null = 0): ToolRun => ({
  path,
  exitCode,
  output,
});

const linuxTools: Record<ToolName, ToolRun | undefined> = {
  npm: ran('/usr/bin/npm', '11.6.2\n'),
  git: ran('/usr/bin/git', 'git version 2.47.1\n'),
  claude: ran('/home/brewer/.local/bin/claude', '2.1.300 (Claude Code)\n'),
  bwrap: ran('/usr/bin/bwrap', 'bubblewrap 0.9.0\n'),
  socat: ran('/usr/bin/socat', 'socat by Gerhard Rieger\nsocat version 1.7.4.4 on Jan  1 2024\n'),
  podman: undefined,
  docker: undefined,
};

/** Ubuntu with every tool doctor looks for except a container runtime; `tools` replaces some. */
export const linux = (tools: Partial<Record<ToolName, ToolRun | undefined>> = {}): DoctorFacts => ({
  platform: 'linux',
  kernelRelease: '6.8.0-45-generic',
  node: '24.20.0',
  tools: { ...linuxTools, ...tools },
});

export const windows: DoctorFacts = {
  platform: 'win32',
  kernelRelease: '10.0.26200',
  node: '24.20.0',
  tools: {
    npm: ran('C:\\Program Files\\nodejs\\npm.cmd', '11.6.2\r\n'),
    git: ran('C:\\Program Files\\Git\\cmd\\git.exe', 'git version 2.47.1.windows.1\r\n'),
    claude: ran('C:\\Users\\brewer\\.local\\bin\\claude.exe', '2.1.300 (Claude Code)\r\n'),
    bwrap: undefined,
    socat: undefined,
    podman: undefined,
    docker: undefined,
  },
};

export const macos: DoctorFacts = {
  platform: 'darwin',
  kernelRelease: '24.6.0',
  node: '24.20.0',
  tools: { ...linuxTools, bwrap: undefined, socat: undefined },
};
