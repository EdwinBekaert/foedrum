// `foedrum doctor`, the core (ADR 0021): turns facts gathered from the machine into a report of
// the tools Foedrum needs, the effective isolation level (ADR 0010, architecture §13) and what
// is missing. doctor-facts.ts gathers the facts.

import { type BreweryFiles, INVALID_RECIPES, loadRecipes } from '../engine/recipe-files.ts';
import { BreweryConfig, githubHostOf } from '../schemas/brewery-config.ts';
import { readJsonc } from '../schemas/read.ts';
import { columns } from './columns.ts';

/** The tools doctor looks for on PATH. */
export type ToolName = 'npm' | 'git' | 'gh' | 'claude' | 'bwrap' | 'socat' | 'podman' | 'docker';

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
  /** The text of foedrum.jsonc in the working directory; absent when there is none. */
  config?: string | undefined;
  /** Why foedrum.jsonc could not be read, when it is there and could not be. */
  configUnreadable?: string | undefined;
  /** The Brewery's recipe and brewer files in the working directory (ADR 0053). */
  brewery?: BreweryFiles | undefined;
  /** gh's login and git's credential helpers for the Brewery's GitHub host (ADR 0073). */
  github?: GitHubFacts | undefined;
  /** Whether the local gate's personal denylist is set, and where (ADR 0114); never its words. */
  denylist?: DenylistFact | undefined;
  /** On Linux, whether AppArmor restricts unprivileged user namespaces, which bwrap needs (ADR 0076). */
  restrictsUserns?: boolean | undefined;
}

/** The denylist's state as doctor reports it: its path, never its words or their count. */
export type DenylistFact =
  | { kind: 'none' | 'set'; path: string }
  | { kind: 'unreadable'; path: string; why: string };

/** How a command answered: its exit code (`null` when it could not start or was killed) and output. */
export interface CommandRun {
  exitCode: number | null;
  output: string;
}

/** What doctor asks about the GitHub host Foedrum reaches through gh's own login (ADR 0073). */
export interface GitHubFacts {
  /** gh's `--hostname`: `github.com`, a GitHub Enterprise host or `github.localhost`. */
  host: string;
  /** `gh auth status --hostname <host>`, without the token variables; undefined without gh. */
  login: CommandRun | undefined;
  /** What `git config --null --get-regexp ^credential\.` printed; undefined without git. */
  credentials: CommandRun | undefined;
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
  /**
   * The paths of Foedrum's default files the Brewery's recipes use, when doctor read its files
   * and they load: those it has no file of the same name for (ADR 0098).
   */
  defaults?: readonly string[];
  /** The local gate's denylist, when doctor looked for it (ADR 0114). */
  denylist?: DenylistFact;
  /** No required problem. */
  ok: boolean;
}

// package.json's engines.
const MIN_NODE = [24, 15] as const;
// git reads GIT_CONFIG_COUNT, which a brewer's forced configuration rests on, since 2.31.0 (ADR 0109).
const MIN_GIT = [2, 31, 0] as const;
const GIT_INSTALL = 'install git 2.31.0 or later, https://git-scm.com/downloads';
// gh keeps its login in the OS keyring by default since 2.26.0 (ADR 0073).
const MIN_GH = [2, 26, 0] as const;
const GH_INSTALL =
  'install the GitHub CLI 2.26.0 or later, https://cli.github.com, then run gh auth login';
// The helper `gh auth setup-git` writes: `!gh auth git-credential`, with gh's path.
// gh's token line, masked or not, and anything that looks like a token: never quoted in a report.
const TOKEN_LINE = /token:|\b(?:gh[opsu]_|github_pat_)/i;
const GH_HELPER = /(?:^|[\s!'"\\/])gh(?:\.exe)?['"]?\s+auth\s+git-credential(?:\s|$)/i;

const SANDBOX_TOOLS = 'bubblewrap and socat';
const WSL2_ADVICE =
  'For untrusted repositories, run Foedrum inside WSL2, where shell commands are sandboxed.';
/**
 * What each level keeps from gh's login (ADR 0082, #229). Claude Code's sandbox docs settle the
 * hosts file and the token variables (ADR 0087), not the OS keyring, so the sandbox never "closes"
 * it, and on WSL2 its `~/` entries leave the Windows user's logins under /mnt readable; the
 * container mounts only the worktree (ADR 0010). Check steps run in an OS sandbox of Foedrum's own
 * with no network, outside one only on native Windows (ADR 0076).
 */
const SANDBOX_HIDES =
  "hides gh's hosts file at its default path and the token variables from a brewer's shell commands and keeps them from reaching GitHub; Claude Code's docs don't say whether the sandbox stops a read from the OS keyring.";
const WSL2_WINDOWS_HOME =
  "Under WSL, it doesn't hide the Windows user's logins under /mnt (ADR 0087).";
const sandboxHides = (wsl: boolean) =>
  wsl ? `${SANDBOX_HIDES} ${WSL2_WINDOWS_HOME}` : SANDBOX_HIDES;
const CONTAINER_CLOSES = 'container level mounts only the worktree, which closes both.';
const WRITTEN_DOWN =
  'A login a brewer did read is stopped at the push (ADR 0079) and left out of the pull request and the status comment (ADR 0088) when it looks like one.';
/** Where check steps run (ADR 0076): bwrap or sandbox-exec, and outside one on native Windows. */
const CHECKS_SANDBOXED =
  "Check steps run in an OS sandbox of their own, with no network and the home folder hidden, so they can't read gh's login (ADR 0076).";
const CHECKS_IN_BUBBLEWRAP =
  "Check steps run only in bubblewrap's sandbox, with no network and the home folder hidden; where it cannot start, they do not run (ADR 0076).";
const CHECKS_ON_WINDOWS =
  "On native Windows, check steps run outside any sandbox, so they can still read gh's login (ADR 0076).";
const permissionsOnlyAdvice = (
  sandbox: string | undefined,
  { wsl = false, windows = false }: { wsl?: boolean; windows?: boolean } = {},
) =>
  [
    `${windows ? 'A brewer or a check step runs' : 'A brewer runs'} as you here, so it can still read gh's login from the OS keyring or its hosts file.`,
    sandbox === undefined
      ? `The ${CONTAINER_CLOSES}`
      : `${sandbox} ${sandboxHides(wsl)} For brewers, the ${CONTAINER_CLOSES}`,
    WRITTEN_DOWN,
    windows ? CHECKS_ON_WINDOWS : CHECKS_IN_BUBBLEWRAP,
  ].join(' ');
const sandboxedAdvice = (wsl: boolean) =>
  `The sandbox ${sandboxHides(wsl)} ${WRITTEN_DOWN} ${CHECKS_SANDBOXED}`;
const wsl2OrContainer = (windows: boolean) =>
  permissionsOnlyAdvice('In WSL2, the sandboxed level', { wsl: true, windows });

/**
 * Ubuntu 24.04 and later keep bwrap from making the user namespaces its sandbox needs, unless an
 * AppArmor profile lets it: Claude Code's sandbox docs, "Ubuntu 24.04 and later: allow bubblewrap to
 * create user namespaces" (ADR 0076). Seen on CI's ubuntu leg (#357).
 */
const USERNS_ADVICE =
  'AppArmor restricts unprivileged user namespaces here (kernel.apparmor_restrict_unprivileged_userns is 1), so bwrap cannot make its sandbox unless a profile lets it: brewers\' sandboxed commands and check steps then do not start. Add the AppArmor profile for /usr/bin/bwrap that Claude Code\'s sandbox docs give (https://code.claude.com/docs/en/sandboxing, "Ubuntu 24.04 and later: allow bubblewrap to create user namespaces"), then run sudo systemctl reload apparmor.';

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

/** Whether the dotted version `version` comes before `least`. */
const isBefore = (version: string, least: readonly number[]): boolean => {
  const parts = version.split('.').map(Number);
  for (const [i, want] of least.entries()) {
    const have = parts[i] ?? 0;
    if (have !== want) return have < want;
  }
  return false;
};

const isTooOld = (node: string): boolean => isBefore(node, MIN_NODE);

/**
 * The host gh reaches the Brewery's GitHub on: the one foedrum.jsonc's `githubApi` names, else
 * `github.com` (ADR 0073), also when the file is missing or not valid.
 */
export const githubHostOfConfig = (config: string | undefined): string => {
  const read = config === undefined ? undefined : readJsonc(config, BreweryConfig);
  const api = read?.valid === true ? read.value.githubApi : undefined;
  return (api === undefined ? undefined : githubHostOf(api)) ?? 'github.com';
};

// Whether a credential URL from git's configuration covers every https URL of `host`: the same
// scheme and host, no user, port or path that would narrow it.
const coversHost = (pattern: string, host: string): boolean => {
  const url = URL.parse(pattern);
  if (url === null || url.protocol !== 'https:' || url.username !== '' || url.port !== '') {
    return false;
  }
  return url.hostname === host.toLowerCase() && (url.pathname === '' || url.pathname === '/');
};

/**
 * The credential helpers git asks for `https://<host>`, in order, from what
 * `git config --null --get-regexp ^credential\.` printed: `credential.helper` and
 * `credential.<url>.helper` of a URL that covers the host, where an empty value clears the list
 * before it, as git does.
 */
export const credentialHelpersFor = (host: string, listed: string): string[] => {
  const helpers: string[] = [];
  for (const entry of listed.split('\0')) {
    const newline = entry.indexOf('\n');
    const key = newline === -1 ? entry : entry.slice(0, newline);
    const value = newline === -1 ? '' : entry.slice(newline + 1);
    const helper = /^credential\.(?:(.+)\.)?helper$/i.exec(key);
    if (helper === null) continue;
    if (helper[1] !== undefined && !coversHost(helper[1], host)) continue;
    if (value === '') helpers.length = 0;
    else helpers.push(value);
  }
  return helpers;
};

// gh, its login and git's credential helper (ADR 0073): Foedrum reaches GitHub only through gh's
// own login, for the API and, as git's credential helper, for pushes.
const githubProblems = ({ tools, github }: DoctorFacts): Problem[] => {
  const host = github?.host ?? 'github.com';
  const version = versionOf(tools.gh);
  if (version === undefined) return requiredProblems('gh', tools.gh, GH_INSTALL);
  if (isBefore(version, MIN_GH)) {
    return [{ required: true, what: `gh ${version} is too old`, fix: GH_INSTALL }];
  }
  const problems: Problem[] = [];
  const login = github?.login;
  // What gh said after the host's own line, unless it only says what the problem says already.
  const said = login?.output
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line !== '' && line !== host && !TOKEN_LINE.test(line));
  const because = said === undefined || /not logged in/i.test(said) ? '' : ` (${said})`;
  if (login !== undefined && login.exitCode === null) {
    problems.push({
      required: true,
      what: `gh auth status --hostname ${host} did not answer${because}`,
      fix: `check that gh auth status --hostname ${host} works`,
    });
  } else if (login !== undefined && login.exitCode !== 0) {
    problems.push({
      required: true,
      what: `gh is not logged in to ${host}${because}`,
      fix: `run gh auth login --hostname ${host}`,
    });
  }
  const credentials = github?.credentials;
  // git exits 1 when nothing matches: no helper at all. Any other failure says nothing of them.
  if (credentials !== undefined && credentials.exitCode !== 0 && credentials.exitCode !== 1) {
    const first = credentials.output
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line !== '');
    problems.push({
      required: false,
      what: `git config did not list its credential helpers${first === undefined ? '' : ` (${first})`}`,
      fix: 'check that git config --get-regexp ^credential\\. works in this folder',
    });
  } else if (credentials !== undefined) {
    const { exitCode, output } = credentials;
    const [first] = credentialHelpersFor(host, exitCode === 0 ? output : '');
    if (first === undefined || !GH_HELPER.test(first)) {
      problems.push({
        required: false,
        what:
          first === undefined
            ? `git has no credential helper for https://${host}`
            : `git asks ${first} for https://${host} credentials, not gh`,
        fix: `run gh auth setup-git --hostname ${host}, so git pushes with gh's login`,
      });
    }
  }
  return problems;
};

// git, and one that reads the configuration a brewer's git is given in its environment.
const gitProblems = (run: ToolRun | undefined): Problem[] => {
  const version = versionOf(run);
  if (version === undefined) {
    return requiredProblems('git', run, 'install git, https://git-scm.com/downloads');
  }
  return isBefore(version, MIN_GIT)
    ? [{ required: true, what: `git ${version} is too old`, fix: GIT_INSTALL }]
    : [];
};

// git, gh and claude: Foedrum cannot run brewers without them.
const requiredProblems = (name: 'git' | 'gh' | 'claude', run: ToolRun | undefined, fix: string) => {
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

// foedrum.jsonc, when the working directory has one: a config that does not pass its schema (two
// repositories with one alias, ADR 0050) stops the Brewery, so doctor says why, in one line.
const configProblems = ({ config, configUnreadable }: DoctorFacts): Problem[] => {
  if (configUnreadable !== undefined) {
    return [{ required: true, what: 'foedrum.jsonc cannot be read', fix: configUnreadable }];
  }
  if (config === undefined) return [];
  const read = readJsonc(config, BreweryConfig);
  if (read.valid) return [];
  const fix = read.reason
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join(' ');
  return [{ required: true, what: 'foedrum.jsonc is not valid', fix }];
};

// The recipe and brewer files, when doctor read them: files that do not load stop every command
// that needs recipes, with this same line (ADR 0053).
// The defaults in use, when they load (ADR 0098).
const recipesOf = ({ brewery }: DoctorFacts): { problems: Problem[]; defaults?: string[] } => {
  if (brewery === undefined) return { problems: [] };
  const loaded = loadRecipes(brewery);
  if (loaded.valid) return { problems: [], defaults: [...loaded.defaults] };
  return {
    problems: [{ required: true, what: INVALID_RECIPES, fix: loaded.problems.join('; ') }],
  };
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
      return level({ level: 'sandboxed', why: 'macOS Seatbelt' }, [sandboxedAdvice(false)]);
    case 'win32':
      return level(
        { level: 'permissions only', why: 'native Windows has no sandbox for shell commands' },
        [WSL2_ADVICE, wsl2OrContainer(true)],
      );
    case 'linux': {
      // WSL 1 runs Linux programs on the Windows kernel, which has no bubblewrap; WSL 2 has. WSL 1
      // reports a release such as 4.4.0-19041-Microsoft; WSL 2 kernels say microsoft-standard,
      // and later also WSL2.
      const wsl = /microsoft/i.test(kernelRelease);
      if (wsl && !/microsoft-standard|wsl2/i.test(kernelRelease)) {
        return level({ level: 'permissions only', why: 'WSL 1 has no sandbox' }, [
          WSL2_ADVICE,
          wsl2OrContainer(false),
        ]);
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
          [permissionsOnlyAdvice(`The sandboxed level (${SANDBOX_TOOLS})`, { wsl })],
          missing,
        );
      }
      return level({ level: 'sandboxed', why: wsl ? `WSL2, ${SANDBOX_TOOLS}` : SANDBOX_TOOLS }, [
        sandboxedAdvice(wsl),
      ]);
    }
    default:
      return level({ level: 'permissions only', why: `no sandbox on ${platform}` }, [
        permissionsOnlyAdvice(undefined),
      ]);
  }
};

/** What doctor reports for the facts; `ok` when nothing required is missing. */
export const diagnose = (facts: DoctorFacts): Diagnosis => {
  const { tools } = facts;
  const { isolation, advice: levelAdvice, problems: sandboxProblems } = isolationOf(facts);
  const advice =
    facts.platform === 'linux' && facts.restrictsUserns === true
      ? [...levelAdvice, USERNS_ADVICE]
      : levelAdvice;
  const recipes = recipesOf(facts);
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
    ...gitProblems(tools.git),
    ...githubProblems(facts),
    ...requiredProblems(
      'claude',
      tools.claude,
      'install Claude Code, https://code.claude.com/docs/en/setup',
    ),
    ...jobObjectProblems(facts),
    ...configProblems(facts),
    ...recipes.problems,
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
      toolLine('gh', tools.gh),
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
    ...(recipes.defaults === undefined ? {} : { defaults: recipes.defaults }),
    ...(facts.denylist === undefined ? {} : { denylist: facts.denylist }),
    ok: problems.every((problem) => !problem.required),
  };
};

// Whether the local gate's denylist is set, and where: never its words or how many (ADR 0114).
const denylistLine = (denylist: DenylistFact): string => {
  switch (denylist.kind) {
    case 'set':
      return `Denylist: ${denylist.path} (the local gate blocks its words in what git push and gh send, ADR 0114, ADR 0132)`;
    case 'none':
      return `Denylist: none (optional; the local gate reads FOEDRUM_DENYLIST or ${denylist.path}, ADR 0114)`;
    case 'unreadable':
      return `Denylist: ${denylist.path} cannot be read (${denylist.why}); the local gate blocks every push and every gh text until it can (ADR 0114, ADR 0132)`;
    default: {
      const unknown: never = denylist;
      throw new Error(`unknown denylist state ${JSON.stringify(unknown)}`);
    }
  }
};

/** The report `foedrum doctor` prints. */
export const formatDiagnosis = ({
  tools,
  isolation,
  container,
  advice,
  problems,
  defaults,
  denylist,
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
    ...(defaults === undefined
      ? []
      : [
          defaults.length === 0
            ? 'Defaults in use: none'
            : `Defaults in use: ${defaults.join(', ')} (a Brewery file of the same name replaces one)`,
        ]),
    ...(denylist === undefined ? [] : [denylistLine(denylist)]),
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
