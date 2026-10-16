// `foedrum doctor`, the core (ADR 0021): turns facts gathered from the machine into a report of
// the tools Foedrum needs, the effective isolation level (ADR 0010, architecture §13) and what
// is missing. doctor-facts.ts gathers the facts.

import { columns } from './columns.ts';

/** The tools doctor looks for on PATH. */
export type ToolName = 'npm' | 'git' | 'claude' | 'bwrap' | 'socat' | 'podman' | 'docker';

/** A tool found on PATH, and what its version command answered. */
export interface ToolRun {
  path: string;
  /** The exit code of the version command; `null` when it could not start or was killed. */
  exitCode: number | null;
  output: string;
}

export interface DoctorFacts {
  platform: NodeJS.Platform;
  /** `os.release()`; on Linux it tells WSL 1 and WSL 2 apart. */
  kernelRelease: string;
  /** `process.versions.node` */
  node: string;
  /** Each tool, or `undefined` when it is not on PATH. */
  tools: Readonly<Record<ToolName, ToolRun | undefined>>;
  /**
   * On Windows, how a process held in a Job Object answered (ADR 0039): brewers run only in one.
   * `undefined` elsewhere.
   */
  jobObject?: { exitCode: number | null; output: string } | undefined;
}

/** The isolation levels Foedrum can reach without configuration (ADR 0010). */
export type IsolationLevel = 'sandboxed' | 'permissions only';

/** One row of the report: a tool, its version and where it is; no path when it was not found. */
export interface ToolLine {
  name: string;
  /** `undefined` when the tool did not report one. */
  version: string | undefined;
  path: string | undefined;
}

export interface Problem {
  /** A required problem stops Foedrum from running brewers; doctor then exits 1. */
  required: boolean;
  what: string;
  fix: string;
}

type ContainerName = 'podman' | 'docker';

export interface Diagnosis {
  tools: readonly ToolLine[];
  isolation: { level: IsolationLevel; why: string };
  /**
   * The container runtime that makes the optional container level possible; one that is on PATH
   * but does not answer its version is not usable, with what it said first.
   */
  container:
    | { name: ContainerName; version: string; path: string; usable: true }
    | {
        name: ContainerName;
        version: undefined;
        path: string;
        usable: false;
        said: string | undefined;
      }
    | undefined;
  advice: readonly string[];
  problems: readonly Problem[];
  /** No required problem. */
  ok: boolean;
}

// package.json's engines.
const MIN_NODE = [24, 15] as const;

const SANDBOX_TOOLS = 'bubblewrap and socat';
const WSL2_ADVICE =
  'For untrusted repositories, run Foedrum inside WSL2, where shell commands are sandboxed.';

/** The first dotted number a version command printed; `undefined` when it failed. */
const versionOf = (run: ToolRun | undefined): string | undefined =>
  run?.exitCode === 0 ? /\d+(?:\.\d+)+/.exec(run.output)?.[0] : undefined;

/** What a tool, or the runner that could not start it, said first. */
const firstLine = (run: { output: string }): string | undefined =>
  run.output
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line !== '');

const toolLine = (name: ToolName, run: ToolRun | undefined): ToolLine => ({
  name,
  version: versionOf(run),
  path: run?.path,
});

const isTooOld = (node: string): boolean => {
  const [major = 0, minor = 0] = node.split('.').map(Number);
  return major < MIN_NODE[0] || (major === MIN_NODE[0] && minor < MIN_NODE[1]);
};

// git and claude: Foedrum cannot run brewers without them.
const requiredProblems = (name: 'git' | 'claude', run: ToolRun | undefined, fix: string) => {
  if (run === undefined) return [{ required: true, what: `${name} not found`, fix }];
  if (versionOf(run) === undefined) {
    const said = firstLine(run);
    return [
      {
        required: true,
        what: `${name} at ${run.path} did not report a version`,
        fix:
          said === undefined
            ? `check that \`${name} --version\` works`
            : `\`${name} --version\` failed: ${said}`,
      },
    ];
  }
  return [];
};

// Windows: a brewer's processes run in a kill-on-close Job Object, so a stop ends them all; the
// helper that makes one needs PowerShell in Full Language mode (ADR 0039).
const jobObjectProblems = ({ platform, jobObject }: DoctorFacts): Problem[] => {
  if (platform !== 'win32' || jobObject === undefined || jobObject.exitCode === 0) return [];
  const said = firstLine(jobObject);
  return [
    {
      required: true,
      what: `Windows cannot hold a brewer's processes in a Job Object${said === undefined ? '' : ` (${said})`}`,
      fix: 'Foedrum needs PowerShell in Full Language mode to stop every process a brewer starts; where a policy keeps it in Constrained Language Mode, run Foedrum inside WSL2',
    },
  ];
};

/** The effective isolation level (ADR 0010, architecture §13) and what to do about it. */
const isolationOf = ({ platform, kernelRelease, tools }: DoctorFacts) => {
  const level = (
    isolation: Diagnosis['isolation'],
    advice: string[] = [],
    problems: Problem[] = [],
  ) => ({
    isolation,
    advice,
    problems,
  });
  switch (platform) {
    case 'darwin':
      return level({ level: 'sandboxed', why: 'macOS Seatbelt' });
    case 'win32':
      return level(
        { level: 'permissions only', why: 'native Windows has no sandbox for shell commands' },
        [WSL2_ADVICE],
      );
    case 'linux': {
      // WSL 1 runs Linux programs on the Windows kernel, which has no bubblewrap; WSL 2 has. WSL 1
      // reports a release such as 4.4.0-19041-Microsoft; WSL 2 kernels say microsoft-standard,
      // and later also WSL2.
      const wsl = /microsoft/i.test(kernelRelease);
      if (wsl && !/microsoft-standard|wsl2/i.test(kernelRelease)) {
        return level({ level: 'permissions only', why: 'WSL 1 has no sandbox' }, [WSL2_ADVICE]);
      }
      const missing: Problem[] = [];
      if (tools.bwrap === undefined) {
        missing.push({
          required: false,
          what: 'bubblewrap (bwrap) not found',
          fix: 'install bubblewrap for the sandboxed level',
        });
      }
      if (tools.socat === undefined) {
        missing.push({
          required: false,
          what: 'socat not found',
          fix: 'install socat for the sandboxed level',
        });
      }
      if (missing.length > 0) {
        return level(
          { level: 'permissions only', why: `the sandbox needs ${SANDBOX_TOOLS}` },
          [],
          missing,
        );
      }
      return level({ level: 'sandboxed', why: wsl ? `WSL2, ${SANDBOX_TOOLS}` : SANDBOX_TOOLS });
    }
    default:
      return level({ level: 'permissions only', why: `no sandbox on ${platform}` });
  }
};

/** What doctor reports for the facts; `ok` when nothing required is missing. */
export const diagnose = (facts: DoctorFacts): Diagnosis => {
  const { tools } = facts;
  const { isolation, advice, problems: sandboxProblems } = isolationOf(facts);
  const problems: Problem[] = [
    ...(isTooOld(facts.node)
      ? [
          {
            required: true,
            what: `node ${facts.node} is too old`,
            fix: 'install Node 24.15 or later',
          },
        ]
      : []),
    ...(tools.npm === undefined
      ? [
          {
            required: false,
            what: 'npm not found',
            fix: 'Foedrum is installed and updated with npm, which comes with Node',
          },
        ]
      : []),
    ...requiredProblems('git', tools.git, 'install git, https://git-scm.com/downloads'),
    ...requiredProblems(
      'claude',
      tools.claude,
      'install Claude Code, https://code.claude.com/docs/en/setup',
    ),
    ...jobObjectProblems(facts),
    ...sandboxProblems,
  ];
  // Podman first: it runs without a daemon or root. One that does not answer its version (a
  // runtime waiting for its daemon) is passed over for the next; when none answers, the first
  // is reported as not usable.
  const containers = (['podman', 'docker'] as const).flatMap(
    (name): NonNullable<Diagnosis['container']>[] => {
      const run = tools[name];
      if (run === undefined) return [];
      const version = versionOf(run);
      return [
        version === undefined
          ? { name, version, path: run.path, usable: false, said: firstLine(run) }
          : { name, version, path: run.path, usable: true },
      ];
    },
  );
  const container = containers.find((found) => found.usable) ?? containers[0];
  return {
    tools: [
      { name: 'node', version: facts.node, path: undefined },
      toolLine('npm', tools.npm),
      toolLine('git', tools.git),
      toolLine('claude', tools.claude),
      // The sandbox's own tools matter on Linux only.
      ...(facts.platform === 'linux'
        ? [toolLine('bwrap', tools.bwrap), toolLine('socat', tools.socat)]
        : []),
    ],
    isolation,
    container,
    advice,
    problems,
    ok: problems.every((problem) => !problem.required),
  };
};

/** The report `foedrum doctor` prints. */
export const formatDiagnosis = ({
  tools,
  isolation,
  container,
  advice,
  problems,
  ok,
}: Diagnosis): string => {
  const lines = [
    'Foedrum doctor',
    '',
    ...columns(
      tools.map(({ name, version, path }) => [
        name,
        version ?? (path === undefined ? 'missing' : 'unknown'),
        path ?? '',
      ]),
    ),
    '',
    `Isolation: ${isolation.level} (${isolation.why})`,
    ...advice.map((line) => `  ${line}`),
    container === undefined
      ? 'Container: no Podman or Docker (optional)'
      : container.usable
        ? `Container: ${container.name} ${container.version} at ${container.path}; the container level is available`
        : `Container: ${container.name} at ${container.path} does not answer its version${container.said === undefined ? '' : ` (${container.said})`}; the container level is not available`,
    '',
  ];
  if (problems.length > 0) {
    lines.push(
      'Problems:',
      ...problems.map(
        ({ required, what, fix }) => `  ${what}${required ? ' (required)' : ''}: ${fix}`,
      ),
      '',
    );
  }
  lines.push(
    !ok
      ? 'Foedrum cannot run brewers until the required problems are fixed.'
      : problems.length > 0
        ? 'Foedrum can run; the problems above are optional.'
        : 'Foedrum has everything it needs.',
  );
  return `${lines.join('\n')}\n`;
};
