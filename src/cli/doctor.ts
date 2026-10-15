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

export interface Diagnosis {
  tools: readonly ToolLine[];
  isolation: { level: IsolationLevel; why: string };
  /** A container runtime, which makes the optional container level possible. */
  container: { name: 'podman' | 'docker'; version: string | undefined; path: string } | undefined;
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
    return [
      {
        required: true,
        what: `${name} at ${run.path} did not report a version`,
        fix: `check that \`${name} --version\` works`,
      },
    ];
  }
  return [];
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
      // WSL 1 runs Linux programs on the Windows kernel, which has no bubblewrap; WSL 2 has.
      const wsl = /microsoft/i.test(kernelRelease);
      if (wsl && !/wsl2/i.test(kernelRelease)) {
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
    ...sandboxProblems,
  ];
  // Podman first: it runs without a daemon or root.
  const [container] = (['podman', 'docker'] as const).flatMap((name) => {
    const run = tools[name];
    return run === undefined ? [] : [{ name, version: versionOf(run), path: run.path }];
  });
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
      : `Container: ${container.name} ${container.version ?? 'of unknown version'} at ${container.path}; the container level is available`,
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
