// Claude Code PreToolUse hook: blocks force pushes, deleting or mirroring pushes and
// `gh pr merge`, and runs `npm run check` before `git push` and `gh pr create`.
// Wired in .claude/settings.json as `npm run --silent --prefix "${CLAUDE_PROJECT_DIR}" hook:gate
// || exit 2`, so npm provides npm_execpath and the check itself runs without a shell.
// Exit 0 lets the tool call through; exit 2 blocks it and shows stderr to Claude.
// It runs before every Bash and PowerShell call, so input that cannot name git or gh exits
// before any parsing, and the module has no static imports.

export interface CheckResult {
  ok: boolean;
  output: string;
}

export type RunCheck = (cwd: string) => Promise<CheckResult>;

export interface HookResult {
  exitCode: 0 | 2;
  stderr: string;
}

const MAX_OUTPUT_CHARS = 4000;
const COMMAND_SEPARATORS = /&&|\|\||[;&|\r\n(){}]/;
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const GIT_OPTIONS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace']);
// gh flags that can appear before the `pr` action and take the next token as their value.
const GH_OPTIONS_WITH_VALUE = new Set(['-R', '--repo', '--hostname']);
// Case-insensitive because `GIT push` works on Windows; \u because JSON can escape any letter.
const MAY_NAME_GIT_OR_GH = /git|gh|\\u/i;

// Splits on both separators, so this works for Windows and POSIX paths.
const programName = (token: string): string =>
  (token.split(/[\\/]/).at(-1) ?? '').toLowerCase().replace(/\.exe$/, '');

const tokenize = (segment: string): string[] => {
  const tokens = segment
    .trim()
    .split(/\s+/)
    .map((token) => token.replace(/^["']+|["']+$/g, ''))
    .filter((token) => token !== '');
  while (tokens[0] !== undefined && ENV_ASSIGNMENT.test(tokens[0])) tokens.shift();
  return tokens;
};

interface Invocation {
  program: string;
  args: string[];
}

const invocations = (command: string): Invocation[] =>
  command.split(COMMAND_SEPARATORS).flatMap((segment) => {
    const [program, ...args] = tokenize(segment);
    return program === undefined ? [] : [{ program: programName(program), args }];
  });

// The arguments after `push` when this is a `git push`, otherwise undefined.
const gitPushArgs = ({ program, args }: Invocation): string[] | undefined => {
  if (program !== 'git') return undefined;
  let i = 0;
  while (args[i]?.startsWith('-')) i += GIT_OPTIONS_WITH_VALUE.has(args[i] ?? '') ? 2 : 1;
  return args[i] === 'push' ? args.slice(i + 1) : undefined;
};

// The positional arguments, skipping flags and the values of flags that take one.
const positionals = (args: string[], optionsWithValue: Set<string>): string[] => {
  const result: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (!arg.startsWith('-')) result.push(arg);
    else if (optionsWithValue.has(arg)) i++;
  }
  return result;
};

// The action after `gh pr`, such as `create` or `merge`, otherwise undefined.
const ghPrAction = ({ program, args }: Invocation): string | undefined => {
  if (program !== 'gh') return undefined;
  const [group, action] = positionals(args, GH_OPTIONS_WITH_VALUE);
  return group === 'pr' ? action : undefined;
};

// --force, --force-with-lease[=…], -f alone or in a group such as -uf, or a +refspec.
const isForceArg = (arg: string): boolean =>
  arg.startsWith('--force') || /^-[A-Za-z]*f[A-Za-z]*$/.test(arg) || arg.startsWith('+');

// --delete, -d alone or in a group, a :branch refspec, or --mirror.
const isDeleteOrMirrorArg = (arg: string): boolean =>
  arg === '--delete' ||
  arg === '--mirror' ||
  /^-[A-Za-z]*d[A-Za-z]*$/.test(arg) ||
  arg.startsWith(':');

const FORCE_PUSH_BLOCKED =
  'Force push is blocked: update a pushed branch by merging origin/main; never rebase or force-push a branch that has been pushed (CLAUDE.md).';
const DELETE_PUSH_BLOCKED =
  'Deleting or mirroring remote refs with git push is blocked: ask a maintainer to delete remote branches.';
const PR_MERGE_BLOCKED =
  '`gh pr merge` is blocked: pull requests are merged by a maintainer, never from a Claude Code session.';

export const isGatedCommand = (command: string): boolean =>
  invocations(command).some((invocation) => {
    const action = ghPrAction(invocation);
    return gitPushArgs(invocation) !== undefined || action === 'create' || action === 'new';
  });

export const forbiddenReason = (command: string): string | undefined => {
  for (const invocation of invocations(command)) {
    const pushArgs = gitPushArgs(invocation) ?? [];
    if (pushArgs.some(isForceArg)) return FORCE_PUSH_BLOCKED;
    if (pushArgs.some(isDeleteOrMirrorArg)) return DELETE_PUSH_BLOCKED;
    if (ghPrAction(invocation) === 'merge') return PR_MERGE_BLOCKED;
  }
  return undefined;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const lastChars = (text: string): string =>
  text.length > MAX_OUTPUT_CHARS ? `…\n${text.slice(-MAX_OUTPUT_CHARS)}` : text;

// Why node_modules in the checkout around `cwd` is out of date, or undefined.
export type StaleReason = (cwd: string) => Promise<string | undefined>;

// Whether HEAD in the checkout around `cwd` is detached.
export type HeadIsDetached = (cwd: string) => Promise<boolean>;

export const precheck = async (
  input: string,
  runCheck: RunCheck,
  staleReason: StaleReason = async () => undefined,
  _headIsDetached: HeadIsDetached = async () => false,
): Promise<HookResult> => {
  if (!MAY_NAME_GIT_OR_GH.test(input)) return { exitCode: 0, stderr: '' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.charCodeAt(0) === 0xfeff ? input.slice(1) : input);
  } catch {
    return { exitCode: 2, stderr: 'precheck: could not parse the hook input as JSON.\n' };
  }
  if (!isRecord(parsed)) {
    return { exitCode: 2, stderr: 'precheck: the hook input is not a JSON object.\n' };
  }

  const command = isRecord(parsed.tool_input) ? parsed.tool_input.command : undefined;
  if (typeof command !== 'string') return { exitCode: 0, stderr: '' };
  const reason = forbiddenReason(command);
  if (reason !== undefined) return { exitCode: 2, stderr: `${reason}\n` };
  if (!isGatedCommand(command)) return { exitCode: 0, stderr: '' };

  const cwd = typeof parsed.cwd === 'string' ? parsed.cwd : process.cwd();
  // A stale tree fails the check deep in an import; say why in one line instead.
  const stale = await staleReason(cwd);
  if (stale !== undefined) {
    return {
      exitCode: 2,
      stderr: `node_modules is out of date with package-lock.json (${stale}); run npm ci\n`,
    };
  }
  const { ok, output } = await runCheck(cwd);
  if (ok) return { exitCode: 0, stderr: '' };
  return {
    exitCode: 2,
    stderr: `npm run check failed, so this command was blocked. Fix the failures and try again.\n\n${lastChars(output.trim())}\n`,
  };
};

// Type-only, so erased: the module still has no static imports.
import type { ProcessOutcome, RunProcess } from './process-runner.ts';

export type { ProcessOutcome, RunProcess } from './process-runner.ts';

// `npm run check` through npm's own CLI script (npm_execpath, set by `npm run hook:gate`), run
// by this node, so the check starts without a shell.
export const npmCheck =
  (env: NodeJS.ProcessEnv, execPath: string, runProcess: RunProcess): RunCheck =>
  async (cwd) => {
    const npmCli = env.npm_execpath;
    if (npmCli === undefined || npmCli === '') {
      return {
        ok: false,
        output: 'npm_execpath is not set: run this hook as `npm run --silent hook:gate`.',
      };
    }
    const { exitCode, output } = await runProcess(execPath, [npmCli, 'run', 'check'], cwd);
    return { ok: exitCode === 0, output };
  };

export const isDetached = (_outcome: ProcessOutcome): boolean => {
  throw new Error('not implemented');
};

export const gitHeadIsDetached =
  (_runProcess: RunProcess): HeadIsDetached =>
  async () => {
    throw new Error('not implemented');
  };

const readStdin = async (): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
};

if (import.meta.main) {
  const { spawnProcess } = await import('./process-runner.ts');
  const runCheck = npmCheck(process.env, process.execPath, spawnProcess);
  // Loaded only for gated commands.
  const staleReason = async (cwd: string) => {
    const { outOfDate } = await import('./deps-sync.ts');
    return (await outOfDate(cwd))?.reason;
  };
  const { exitCode, stderr } = await precheck(await readStdin(), runCheck, staleReason);
  if (stderr !== '') process.stderr.write(stderr);
  process.exitCode = exitCode;
}
