// Claude Code PreToolUse hook: blocks force pushes, deleting or mirroring pushes and
// `gh pr merge` and pushes from a detached HEAD, runs `npm run check -- --no-tests` (typecheck,
// lint and the guards; CI runs the tests, ADR 0249) before `git push`, and lets
// `gh pr ready` through only when the pull request has the /brew-review summary for its head (#154) or changes only plain documentation (#183). It also blocks npx and
// its relatives when they would run a package the lockfile did not install (#175), and a recursive
// delete of a path built from a variable or a substitution (#281), and a push whose commits hold a
// word on the user's personal denylist (#131). The checks run in the tree the command pushes: the
// directory it changes into with cd, git -C and the like (#132).
// Wired in .claude/settings.json as `node "${CLAUDE_PROJECT_DIR}/scripts/precheck.ts"`, without
// npm, which cost about 0.4 s per call (#41); the check runs npm's CLI found next to this node,
// without a shell.
// Exit 0 lets the tool call through; exit 2 blocks it and shows stderr to Claude.
// It runs before every Bash and PowerShell call, so input that cannot name git or gh exits
// before any parsing, and the module imports only the pre-filter (ADR 0252).
//
// The command is read the way bash and PowerShell would read it, both ways, and blocked when
// either reading pushes or merges (#42). Quotes are honoured; wrapper words (env, time, xargs,
// Start-Process, …) are skipped; what other shells and evaluators run (bash -c, pwsh -Command,
// cmd /c, iex, eval) is read as a command too; and a program or subcommand computed at run time
// is assumed to be the worst it could be. Arguments computed at run time are not evaluated.
//
// In parts (ADR 0252): the pre-filter in precheck/prefilter.ts, the lexer and the reader in
// precheck/read.ts, the policies in precheck/core.ts, loaded after the pre-filter; this file
// keeps the hook and the shell that starts git, gh and npm.

import { jsonLineBreaks, mayNeedTheGate } from './precheck/prefilter.ts';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

export const precheck = async (
  input: string,
  runCheck: RunCheck,
  staleReason: StaleReason = async () => undefined,
  headIsDetached: HeadIsDetached = async () => false,
  lookupPullRequest: LookupPullRequest = async () => {
    throw new Error('no pull request lookup');
  },
  binaryInstalled: BinaryInstalled = async () => false,
  inProject: InProject = async () => true,
  deniedPush: DeniedPush = async () => undefined,
  // Loaded only for a command with gh texts to read, so other calls load nothing for it.
  loadDeniedTexts: () => Promise<DeniedTexts> = async () => () => undefined,
  pushConfig: PushConfig = async () => '',
): Promise<HookResult> => {
  if (!mayNeedTheGate(jsonLineBreaks(input))) return { exitCode: 0, stderr: '' };
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
  // The input test above only skips parsing; the command decides, so a cwd, transcript path or
  // description that spells git does not send the call to the parser (#152).
  if (!mayNeedTheGate(command)) return { exitCode: 0, stderr: '' };
  const cwd = typeof parsed.cwd === 'string' ? parsed.cwd : process.cwd();
  const { gate } = await import('./precheck/core.ts');
  return gate(
    command,
    parsed.tool_name,
    cwd,
    runCheck,
    staleReason,
    headIsDetached,
    lookupPullRequest,
    binaryInstalled,
    inProject,
    deniedPush,
    loadDeniedTexts,
    pushConfig,
  );
};

// Type-only, so erased: the module still imports only the pre-filter.
import type { NpmCliLookup } from '../src/platform/executables.ts';
import type { ExecProcess } from '../src/platform/processes.ts';
import type {
  BinaryInstalled,
  DeniedPush,
  DeniedTexts,
  HeadIsDetached,
  HookResult,
  InProject,
  LookupPullRequest,
  PushConfig,
  RunCheck,
  StaleReason,
} from './precheck/core.ts';
import type { ProcessOutcome, RunProcess } from './process-runner.ts';

export type { ProcessOutcome, RunProcess } from './process-runner.ts';

// The check's deadline: after its steps' own (300 s), so a hanging step is named there, and
// before the hook's 600 s, which would end this process without killing the check.
const CHECK_TIMEOUT_MS = 540_000;

// The HEAD check's deadline: a local, read-only git call that should answer at once (#42).
const HEAD_CHECK_TIMEOUT_MS = 10_000;

// Finds npm's CLI script next to the node at the given path (findNpmCli in the platform module).
export type FindNpmCli = (execPath: string) => Promise<NpmCliLookup>;

// `npm run check -- --no-tests` (typecheck, lint and the guards; CI runs the tests, ADR 0249)
// through npm's own CLI script, found next to this node, run by this node, so
// the check starts without a shell. Outside Windows the check leads a process group of its own,
// which a Ctrl+C on the push does not reach: `stop` kills its tree.
export const npmCheck =
  (
    execPath: string,
    findNpmCli: FindNpmCli,
    runProcess: RunProcess,
    stop?: AbortSignal,
  ): RunCheck =>
  async (cwd) => {
    const { path: npmCli, tried } = await findNpmCli(execPath);
    if (npmCli === undefined) {
      return {
        ok: false,
        output: `npm's CLI was not found next to node (${execPath}), so the check cannot run. Tried:\n${tried.map((path) => `  ${path}\n`).join('')}Install npm with this node, or run npm run check yourself.`,
      };
    }
    const { exitCode, output, killed } = await runProcess(
      execPath,
      [npmCli, 'run', 'check', '--', '--no-tests'],
      cwd,
      { timeoutMs: CHECK_TIMEOUT_MS, signal: stop },
    );
    const { whyKilled } = await import('../src/platform/processes.ts');
    const why = whyKilled(killed, CHECK_TIMEOUT_MS);
    if (why === undefined) {
      // A branch that has not merged main since ADR 0249: its check refuses the argument.
      if (exitCode !== 0 && output.includes("Unknown option '--no-tests'")) {
        return {
          ok: false,
          output: `${output.trimEnd()}\nThis branch's scripts/check.ts does not know --no-tests (ADR 0249): merge origin/main and push again.`,
        };
      }
      return { ok: exitCode === 0, output };
    }
    const what = killed === 'stopped' ? 'npm run check was stopped' : `npm run check ${why}`;
    return { ok: false, output: `${output.trimEnd()}\n${what}` };
  };

// `git symbolic-ref -q HEAD` exits 1, silently, only when HEAD is detached. It exits 0 on a branch
// and 128 outside a repository, where git push fails by itself.
export const isDetached = ({ exitCode }: ProcessOutcome): boolean => exitCode === 1;

// Rejects, saying why, when git was killed: at the deadline, when stopped, or at the output limit.
export const gitHeadIsDetached =
  (runProcess: RunProcess): HeadIsDetached =>
  async (cwd) => {
    const outcome = await runProcess('git', ['symbolic-ref', '-q', 'HEAD'], cwd, {
      timeoutMs: HEAD_CHECK_TIMEOUT_MS,
    });
    if (outcome.killed !== undefined) {
      const { whyKilled } = await import('../src/platform/processes.ts');
      const why = whyKilled(outcome.killed, HEAD_CHECK_TIMEOUT_MS);
      throw new Error(
        `git symbolic-ref -q HEAD ${outcome.killed === 'stopped' ? 'was stopped' : why}`,
      );
    }
    return isDetached(outcome);
  };

// Every remote's push and mirror settings, from every scope of git's configuration.
const PUSH_CONFIG = ['config', '-z', '--get-regexp', '^remote\\..*\\.(push|mirror)$'];

// git config's output, or '' when no setting matches (exit 1); rejects, saying why, when git
// fails or is killed. A local read, with the HEAD check's deadline (ADR 0246).
export const gitPushConfig =
  (exec: ExecProcess): PushConfig =>
  async (dir) => {
    const { exitCode, stdout, killed } = await exec('git', PUSH_CONFIG, {
      cwd: dir,
      timeoutMs: HEAD_CHECK_TIMEOUT_MS,
    });
    if (exitCode === 0) return stdout;
    if (exitCode === 1) return '';
    const { whyKilled } = await import('../src/platform/processes.ts');
    const why =
      whyKilled(killed, HEAD_CHECK_TIMEOUT_MS) ??
      (exitCode === null ? 'could not start' : `exited ${exitCode}`);
    throw new Error(`git config ${why}`);
  };

// The deadline of each gh call: GitHub answers in about a second, and a hung call must not hold
// the gate until the hook's own limit.
const GH_TIMEOUT_MS = 30_000;

// gh's output; rejects, saying why, when gh failed or was killed.
const runGh = async (
  runProcess: RunProcess,
  args: string[],
  cwd: string,
  what: string,
): Promise<string> => {
  const { exitCode, output, killed } = await runProcess('gh', args, cwd, {
    timeoutMs: GH_TIMEOUT_MS,
  });
  if (killed !== undefined) {
    const { whyKilled } = await import('../src/platform/processes.ts');
    throw new Error(
      `${what} ${killed === 'stopped' ? 'was stopped' : whyKilled(killed, GH_TIMEOUT_MS)}`,
    );
  }
  if (exitCode !== 0) {
    const how = exitCode === null ? 'could not start' : `exited ${exitCode}`;
    // One short line: gh's output may be pages of commits or a proxy's error page.
    throw new Error(`${what} ${how}: ${output.trim().replace(/\s+/g, ' ').slice(0, 200)}`);
  }
  return output;
};

// The pull request through gh, as gh pr ready would find it: `gh pr view` for its head and
// comments, then its commits with their parents from the REST API, which `gh pr view` leaves out.
export const ghPullRequest =
  (runProcess: RunProcess): LookupPullRequest =>
  async (cwd, { pr, repo }) => {
    const view = await runGh(
      runProcess,
      [
        'pr',
        'view',
        ...(pr === undefined ? [] : [pr]),
        ...(repo === undefined ? [] : ['--repo', repo]),
        '--json',
        'number,url,headRefOid,comments,files,changedFiles',
      ],
      cwd,
      'gh pr view',
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(view);
    } catch {
      throw new Error(`gh pr view did not answer with JSON: ${view.trim().slice(0, 200)}`);
    }
    if (
      !isRecord(parsed) ||
      typeof parsed.number !== 'number' ||
      typeof parsed.url !== 'string' ||
      typeof parsed.headRefOid !== 'string' ||
      !Array.isArray(parsed.comments)
    ) {
      throw new Error('gh pr view answered without number, url, headRefOid and comments');
    }
    const { number, url, headRefOid } = parsed;
    const { host, pathname } = new URL(url);
    const [owner, name] = pathname.split('/').filter((part) => part !== '');
    const commits = await runGh(
      runProcess,
      [
        'api',
        '--hostname',
        host,
        '--paginate',
        `repos/${owner}/${name}/pulls/${number}/commits?per_page=100`,
        '--jq',
        '.[] | [.sha, .parents[].sha] | join(" ")',
      ],
      cwd,
      'gh api',
    );
    // gh lists at most 100 files; a shorter list than the count, or one it cannot read, is left out.
    const listing: unknown[] = Array.isArray(parsed.files) ? parsed.files : [];
    // A renamed or copied file is listed by its new path only, so a reviewed file moved into docs/
    // would look like plain docs: only an added, modified or deleted file counts as read.
    const files = listing.flatMap((file) =>
      isRecord(file) &&
      typeof file.path === 'string' &&
      ['ADDED', 'MODIFIED', 'DELETED'].includes(String(file.changeType))
        ? [file.path]
        : [],
    );
    const listed = files.length === listing.length && files.length === parsed.changedFiles;
    return {
      number,
      head: headRefOid,
      ...(listed ? { files } : {}),
      comments: parsed.comments.map((comment: unknown) =>
        isRecord(comment) && typeof comment.body === 'string' ? comment.body : '',
      ),
      commits: commits
        .split(/\r?\n/)
        .filter((line) => line.trim() !== '')
        .map((line) => {
          const [sha = '', ...parents] = line.trim().split(/\s+/);
          return { sha, parents };
        }),
    };
  };

// Whether `node_modules/.bin/<name>` exists in the package around `cwd`: the nearest folder up
// with a package.json, where npx looks before it downloads.
export const lockfileBinary =
  (
    read: (path: string) => Promise<string | undefined>,
    exists: (path: string) => Promise<boolean>,
  ): BinaryInstalled =>
  async (cwd, name) => {
    const { packageRoot } = await import('./deps-sync.ts');
    const root = await packageRoot(cwd, read);
    if (root === undefined) return false;
    const { join } = await import('node:path');
    return exists(join(root, 'node_modules', '.bin', name));
  };

const readStdin = async (): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
};

// Each module below loads only when a gated command needs it, so a call that does not name git
// or gh starts nothing but this file and its pre-filter (#41, ADR 0252).
if (import.meta.main) {
  const spawnProcess: RunProcess = async (file, args, cwd, options) =>
    (await import('./process-runner.ts')).spawnProcess(file, args, cwd, options);
  const findNpmCli: FindNpmCli = async (execPath) =>
    (await import('../src/platform/executables.ts')).findNpmCli(execPath);
  const runCheck: RunCheck = async (cwd) => {
    const { stopOnSignals } = await import('../src/platform/processes.ts');
    return npmCheck(process.execPath, findNpmCli, spawnProcess, stopOnSignals())(cwd);
  };
  const staleReason = async (cwd: string) => {
    const { outOfDate } = await import('./deps-sync.ts');
    return (await outOfDate(cwd))?.reason;
  };
  const { exitCode, stderr } = await precheck(
    await readStdin(),
    runCheck,
    staleReason,
    gitHeadIsDetached(spawnProcess),
    ghPullRequest(spawnProcess),
    async (cwd, name) => {
      const { access, readFile } = await import('node:fs/promises');
      const read = (path: string) => readFile(path, 'utf8').catch(() => undefined);
      const exists = (path: string) =>
        access(path).then(
          () => true,
          () => false,
        );
      return lockfileBinary(read, exists)(cwd, name);
    },
    // Inside CLAUDE_PROJECT_DIR by real path, as the read guard tells (ADR 0049); without it the
    // gate cannot tell, and fails closed.
    async (dir) => {
      const [{ realPath }, { projectHolds }] = await Promise.all([
        import('../src/platform/real-path.ts'),
        import('./precheck/core.ts'),
      ]);
      return projectHolds(process.env.CLAUDE_PROJECT_DIR, dir, process.platform, (path) =>
        realPath(path),
      );
    },
    // The personal denylist, FOEDRUM_DENYLIST or ~/.config/foedrum/denylist.txt (ADR 0114).
    async (dir, remotes, destinations) => {
      const [{ pushRefusal }, { readDenylist }, { execProcess }, { homedir }, { readFileSync }] =
        await Promise.all([
          import('./denylist.ts'),
          import('../src/platform/denylist.ts'),
          import('../src/platform/processes.ts'),
          import('node:os'),
          import('node:fs'),
        ]);
      const readList = () =>
        readDenylist(process.env, homedir(), (path) => readFileSync(path, 'utf8'));
      return pushRefusal(readList, execProcess, destinations)(dir, ...remotes);
    },
    // The same list for what gh posts (ADR 0132), its files read where gh runs.
    async () => {
      const [
        { ghFileReader, textRefusal },
        { readDenylist },
        path,
        { homedir },
        fs,
        { resolvePlace },
      ] = await Promise.all([
        import('./denylist.ts'),
        import('../src/platform/denylist.ts'),
        import('node:path'),
        import('node:os'),
        import('node:fs'),
        import('./precheck/core.ts'),
      ]);
      const read = (file: string) => fs.readFileSync(file, 'utf8');
      const readList = () => readDenylist(process.env, homedir(), read);
      const files = {
        resolve: (cwd: string, parts: readonly string[]) =>
          resolvePlace(cwd, parts, path, homedir()),
        stat: (file: string) => fs.statSync(file),
        read,
      };
      return textRefusal(readList, ghFileReader(files, process.platform));
    },
    async (dir) => gitPushConfig((await import('../src/platform/processes.ts')).execProcess)(dir),
  );
  if (stderr !== '') process.stderr.write(stderr);
  process.exitCode = exitCode;
}
