// The local gate's policies (ADR 0252): what the reader in read.ts found, held to the project,
// git's push configuration, the denylist, the lockfile's binaries and gh pr ready's review
// summary. It starts no process: git, gh, npm and the files they read come injected from
// scripts/precheck.ts.

import type { GhText } from '../denylist/core.ts';
import { findings, type ReadyTarget, TOOL_DIALECTS } from './read.ts';

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

const configuredPushBlocked = (setting: string): string =>
  `git push is blocked: git's configuration makes it delete, force or mirror remote refs (${setting}); push without that setting, or ask a maintainer.`;
const READY_COMBINED_BLOCKED =
  'gh pr ready is blocked in the same command as git push: the gate reads the pull request before the command runs, so it would check the old head: run it as a command of its own.';
const READY_GH_REPO_BLOCKED =
  'gh pr ready is blocked in a command that mentions GH_REPO or GH_HOST: the gate looks the pull request up without them; give the repository with -R instead.';
const PUSH_PLACE_BLOCKED =
  'git push is blocked: it runs in a directory computed at run time (such as cd "$d" or git -C $d), so the gate cannot tell which tree to check: push from inside the worktree, or name its path as it is.';
const READY_PLACE_BLOCKED =
  'gh pr ready is blocked: it runs in a directory computed at run time (such as cd "$d"), so the gate cannot tell which pull request it marks ready: give the pull request number.';
const manyPlacesBlocked = (dirs: string[]): string =>
  `This command pushes from more than one directory (${dirs.join(', ')}), or the gate read its directory two ways (write the path with /): the gate checks one tree per command; run each from a command of its own.`;
const outsideBlocked = (what: string, dir: string): string =>
  `${what} is blocked: it runs in ${dir}, outside the project this session works in, so the gate does not run that tree's code: ${what === 'git push' ? 'push' : `run ${what}`} from inside that checkout.`;
const downloadBlocked = (run: string): string =>
  `\`${run}\` would download a package that isn't in package-lock.json. Use the project's tools: \`npm run lint -- --write\` formats with Biome.`;
const movedRunBlocked = (run: string): string =>
  `\`${run}\` is blocked in a command that changes directory: the gate looks for it in node_modules/.bin where the command starts, and npx would look where it runs. Run it as a command of its own, from the folder whose node_modules it uses.`;
// A name node_modules/.bin can hold, and nothing that reaches out of it; no trailing dot, which
// Windows drops.
const BINARY_NAME = /^[A-Za-z0-9](?:[\w.-]*[\w-])?$/;
// The names Windows reads as a device in any folder, with or without an extension.
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\..*)?$/i;

// node:path's posix or win32 functions, as a type.
export type PathModule = typeof import('node:path').posix;

// The directory a command runs in: the hook's working directory, then each directory it changes
// into, in order, with Git Bash's /c/… drive paths on Windows and a home path (~, ~/…) expanded.
export const resolvePlace = (
  cwd: string,
  dirs: readonly string[],
  path: PathModule,
  home: string,
): string => {
  if (dirs.length === 0) return cwd;
  const windows = path.sep === '\\';
  const expand = (dir: string): string => {
    if (/^~(?:$|[\\/])/.test(dir)) return path.join(home, dir.slice(1));
    const drive = windows ? /^\/([a-z])(?=\/|$)/i.exec(dir) : null;
    return drive === null ? dir : `${drive[1]?.toUpperCase()}:\\${dir.slice(2)}`;
  };
  return path.resolve(cwd, ...dirs.map(expand));
};

// Whether `dir` is inside the project at `root` (CLAUDE_PROJECT_DIR) by real path, and not in a
// review's scratch folder under .foedrum/tmp/. On Windows a network, device or drive-less path,
// or one on another drive, is refused before anything resolves it.
export const projectHolds = async (
  root: string | undefined,
  dir: string,
  platform: NodeJS.Platform,
  realPath: (path: string) => string,
): Promise<boolean> => {
  const [{ posix, win32 }, { windowsDrive, windowsPathProblem }, { pathInside, samePath }] =
    await Promise.all([
      import('node:path'),
      import('../../src/platform/real-path.ts'),
      import('../../src/platform/paths.ts'),
    ]);
  const path = platform === 'win32' ? win32 : posix;
  if (root === undefined || !path.isAbsolute(root)) return false;
  if (platform === 'win32') {
    if (windowsPathProblem(dir) !== undefined) return false;
    if (windowsDrive(dir) !== windowsDrive(root)) return false;
  }
  try {
    const [project, real] = [realPath(root), realPath(dir)];
    if (samePath(project, real, platform)) return true;
    const inside = pathInside(project, real, platform);
    return inside !== undefined && !/(?:^|\/)\.foedrum\/tmp(?:\/|$)/i.test(inside);
  } catch {
    return false;
  }
};

export const isGatedCommand = (command: string): boolean => findings(command).places.length > 0;

// What git's configuration says false is; a setting without a value is true.
const FALSE = new Set(['false', 'no', 'off', '0', '']);

// The first setting in `git config -z --get-regexp` output that makes a push to one of `remotes`
// delete, force or mirror, as `<key> <value>`: a remote.<r>.mirror that is not false, or a
// remote.<r>.push refspec that starts with + or :. A push that names no remote, or one computed at
// run time, is held to every remote's (ADR 0246).
const configuredDelete = (
  config: string,
  remotes: ReadonlySet<string | null | undefined>,
): string | undefined => {
  const everyRemote = remotes.has(undefined) || remotes.has(null);
  for (const entry of config.split('\0')) {
    const [key = '', value] = entry.split(/\n(.*)/s);
    const setting = /^remote\.(.+)\.(push|mirror)$/s.exec(key);
    if (setting === null || !(everyRemote || remotes.has(setting[1]))) continue;
    const deletes =
      setting[2] === 'mirror'
        ? value === undefined || !FALSE.has(value.toLowerCase())
        : /^[+:]/.test(value ?? '');
    if (deletes) return value === undefined ? key : `${key} ${value}`;
  }
  return undefined;
};

// Why a command may not run: what the gate blocks outright, else what its gh calls would send
// against the personal denylist, read where the hook runs (`cwd`) by `deniedTexts` (ADR 0132).
export const forbiddenReason = (
  command: string,
  deniedTexts?: DeniedTexts,
  cwd = '',
): string | undefined => {
  const found = findings(command);
  if (found.reasons.length > 0 || deniedTexts === undefined || found.texts.length === 0) {
    return found.reasons[0];
  }
  return deniedTexts(found.texts, cwd);
};

const lastChars = (text: string): string =>
  text.length > MAX_OUTPUT_CHARS ? `…\n${text.slice(-MAX_OUTPUT_CHARS)}` : text;

// Why node_modules in the checkout around `cwd` is out of date, or undefined.
export type StaleReason = (cwd: string) => Promise<string | undefined>;

// Whether HEAD in the checkout around `cwd` is detached; rejects when it cannot tell.
export type HeadIsDetached = (cwd: string) => Promise<boolean>;

// Whether the package around `cwd` has `node_modules/.bin/<name>`, a binary the lockfile installed.
export type BinaryInstalled = (cwd: string, name: string) => Promise<boolean>;

// Why a command's pushes from `dir` to `remotes` would send a word on the personal denylist, or
// undefined (ADR 0114); rejects when it cannot tell. Each remote is the one a push names, undefined
// when it names none, and null when it is computed at run time; each destination is a branch name
// a refspec pushes to, null when it is computed at run time (ADR 0246).
export type DeniedPush = (
  dir: string,
  remotes: readonly (string | null | undefined)[],
  destinations: readonly (string | null)[],
) => Promise<string | undefined>;

// Why the texts a command's gh calls would send hold a word on the personal denylist, or cannot be
// read while it is set, or undefined (ADR 0132); files are read from `cwd`.
export type DeniedTexts = (texts: readonly GhText[], cwd: string) => string | undefined;

// The push and mirror settings of every remote in git's configuration in `dir`, as
// `git config -z --get-regexp` prints them; rejects when git cannot read them (ADR 0246).
export type PushConfig = (dir: string) => Promise<string>;

// Whether a directory a command changes into is inside the project the session works in
// (CLAUDE_PROJECT_DIR), so the gate may run that tree's code.
export type InProject = (dir: string) => Promise<boolean>;

// What the gate needs to know of a pull request: its head, its comments, oldest first, and its
// commits (those on its branch that are not on the base) with their parents, and the paths of the
// files it changes, left out when gh could not list them all.
export interface PullRequestFacts {
  number: number;
  head: string;
  comments: string[];
  commits: { sha: string; parents: string[] }[];
  files?: string[];
}

// Reads the pull request from GitHub, run in the checkout around `cwd`; rejects when it cannot.
export type LookupPullRequest = (cwd: string, target: ReadyTarget) => Promise<PullRequestFacts>;

// The heading of a /brew-review summary comment (summary-template.md) and the head it reviewed.
const SUMMARY_HEADING = /^## Review: `[^`\n]*` @ `([0-9a-f]{7,40})`/gm;

// Whether a review of `reviewed` still covers the pull request: it is the head, or every commit
// of the branch that is not part of it is a merge. A merge of the base brings in only commits
// that are on the base, so they are not among the branch's (#146); a commit of the branch's own
// after the review is not a merge, and fails.
const covers = ({ head, commits }: PullRequestFacts, reviewed: string): boolean => {
  if (head.startsWith(reviewed)) return true;
  // A list that leaves out the head (GitHub lists at most 250) cannot show what came after.
  if (!commits.some((commit) => commit.sha === head)) return false;
  const start = commits.find((commit) => commit.sha.startsWith(reviewed));
  if (start === undefined) return false;
  const parents = new Map(commits.map((commit) => [commit.sha, commit.parents]));
  const before = new Set<string>();
  const queue = [start.sha];
  for (const sha of queue) {
    if (before.has(sha)) continue;
    before.add(sha);
    queue.push(...(parents.get(sha) ?? []).filter((parent) => parents.has(parent)));
  }
  return commits.every((commit) => before.has(commit.sha) || commit.parents.length > 1);
};

// Plain documentation, which needs no review summary (#183): Markdown in a subfolder of docs/,
// except the ADRs, which record decisions, and docs/design/. The top-level docs and the design
// pages are the design and the review's criteria, so they are reviewed (ADR 0149). Only a full
// file list counts.
const onlyPlainDocs = (files: string[] | undefined): boolean =>
  files !== undefined &&
  files.length > 0 &&
  files.every((path) => /^docs\/(?!adr\/|design\/)[^/]+\/.*\.md$/i.test(path));

// Why `gh pr ready` may not mark the pull request ready, or undefined when its review summary
// covers the head or it changes only plain documentation.
const readyRefusal = async (
  cwd: string,
  target: ReadyTarget,
  lookupPullRequest: LookupPullRequest,
): Promise<string | undefined> => {
  let pullRequest: PullRequestFacts;
  try {
    pullRequest = await lookupPullRequest(cwd, target);
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    const which = target.pr ?? 'of the current branch';
    return `gh pr ready is blocked: could not read pull request ${which} to find its review summary (${why}).`;
  }
  const { number, head, comments, files } = pullRequest;
  if (onlyPlainDocs(files)) return undefined;
  const reviewed = comments.flatMap((body) =>
    [...body.matchAll(SUMMARY_HEADING)].map((match) => match[1] ?? ''),
  );
  if (reviewed.some((sha) => covers(pullRequest, sha))) return undefined;
  const newest = reviewed.at(-1);
  if (newest === undefined) {
    return `gh pr ready is blocked: pull request #${number} has no /brew-review summary (a comment headed "## Review: \`<branch>\` @ \`<head>\`"). Run /brew-review ${number} and post its summary first; the review is part of the procedure, not a step to get past (CLAUDE.md).`;
  }
  return `gh pr ready is blocked: the newest /brew-review summary on pull request #${number} is for ${newest.slice(0, 7)}, but the head is ${head.slice(0, 7)}, and commits other than merges came after it. Run /brew-review ${number} for the head and post its summary first.`;
};

// The gate after the pre-filter: what the reader finds in `command`, read in the shell of the
// tool that runs it, decided against the injected checks, run where the hook runs (`cwd`).
export const gate = async (
  command: string,
  tool: unknown,
  cwd: string,
  runCheck: RunCheck,
  staleReason: StaleReason,
  headIsDetached: HeadIsDetached,
  lookupPullRequest: LookupPullRequest,
  binaryInstalled: BinaryInstalled,
  inProject: InProject,
  deniedPush: DeniedPush,
  loadDeniedTexts: () => Promise<DeniedTexts>,
  pushConfig: PushConfig,
): Promise<HookResult> => {
  const found = findings(command, TOOL_DIALECTS.get(tool));
  const [reason] = found.reasons;
  if (reason !== undefined) return { exitCode: 2, stderr: `${reason}\n` };
  // What its gh calls would post, against the personal denylist (ADR 0132).
  if (found.texts.length > 0) {
    let denied: string | undefined;
    try {
      denied = (await loadDeniedTexts())(found.texts, cwd);
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      denied = `gh is blocked: could not check what it sends against your denylist (${why}) (ADR 0132).`;
    }
    if (denied !== undefined) return { exitCode: 2, stderr: `${denied}\n` };
  }
  for (const { runner, name, lookup } of found.packages) {
    // Only a plain name is looked up: a version, a scope, a path, a computed name or one Windows
    // maps to a device is not what node_modules/.bin holds.
    if (
      !lookup ||
      name.dynamic ||
      !BINARY_NAME.test(name.text) ||
      WINDOWS_DEVICE.test(name.text) ||
      !(await binaryInstalled(cwd, name.text))
    ) {
      return { exitCode: 2, stderr: `${downloadBlocked(`${runner} ${name.text}`)}\n` };
    }
  }
  const [run] = found.packages;
  if (run !== undefined && found.movesDir) {
    return { exitCode: 2, stderr: `${movedRunBlocked(`${run.runner} ${run.name.text}`)}\n` };
  }
  // Each reading of a command that runs another finds the same pull request again.
  const readies = new Map(found.readies.map((ready) => [JSON.stringify(ready), ready]));
  const pushes = found.places.length > 0;
  if (!pushes && readies.size === 0) return { exitCode: 0, stderr: '' };
  if (readies.size > 0 && pushes) return { exitCode: 2, stderr: `${READY_COMBINED_BLOCKED}\n` };
  // gh reads the repository from them, and the gate's lookup would not.
  if (readies.size > 0 && found.ghEnv) {
    return { exitCode: 2, stderr: `${READY_GH_REPO_BLOCKED}\n` };
  }
  // Where gh pr ready and the check run: the directory the command changes into, if any (#132). The gate
  // runs that tree's code (npm run check, git, gh) before the command is approved, so a
  // directory outside the project blocks the command instead.
  // A push is held to it also where the hook runs, which lasts between a session's commands (ADR
  // 0246).
  const dirOf = async (
    dirs: readonly string[],
    what: string,
    always = false,
  ): Promise<string | HookResult> => {
    if (dirs.length === 0 && !always) return cwd;
    const [path, { homedir }] = await Promise.all([import('node:path'), import('node:os')]);
    const dir = resolvePlace(cwd, dirs, path, homedir());
    if (await inProject(dir)) return dir;
    return { exitCode: 2, stderr: `${outsideBlocked(what, dir)}\n` };
  };

  // Without a number, gh marks the pull request of the branch where it runs; with one, the
  // place only picks the repository, as it does in the hook's working directory.
  if ([...readies.values()].some(({ target, place }) => place === undefined && !target.pr)) {
    return { exitCode: 2, stderr: `${READY_PLACE_BLOCKED}\n` };
  }
  for (const { target, place } of readies.values()) {
    const dir = await dirOf(place ?? [], 'gh pr ready');
    if (typeof dir !== 'string') return dir;
    const refusal = await readyRefusal(dir, target, lookupPullRequest);
    if (refusal !== undefined) return { exitCode: 2, stderr: `${refusal}\n` };
  }
  if (!pushes) return { exitCode: 0, stderr: '' };
  if (found.places.some(({ place }) => place === undefined)) {
    return { exitCode: 2, stderr: `${PUSH_PLACE_BLOCKED}\n` };
  }
  // Each directory a push runs in.
  const trees = new Set<string>();
  for (const { place } of found.places) {
    const dir = await dirOf(place ?? [], 'git push', true);
    if (typeof dir !== 'string') return dir;
    trees.add(dir);
  }
  if (trees.size > 1) {
    return { exitCode: 2, stderr: `${manyPlacesBlocked([...trees])}\n` };
  }
  const [dir = cwd] = trees;
  // Two local reads at once, so the second costs the hook's budget nothing (ADR 0246).
  const [detached, config] = await Promise.allSettled([headIsDetached(dir), pushConfig(dir)]);
  const why = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason));
  // A session pushes a branch; commits made on a detached HEAD are on none (#80).
  if (detached.status === 'rejected') {
    return {
      exitCode: 2,
      stderr: `git push is blocked: could not tell whether HEAD is detached in ${dir} (${why(detached.reason)}).\n`,
    };
  }
  if (detached.value) {
    return {
      exitCode: 2,
      stderr: `git push is blocked: HEAD is detached in ${dir}, so new commits are on no branch; switch to your branch, move it to those commits, and push again.\n`,
    };
  }
  const remotes = new Set(found.places.map(({ remote }) => remote));
  if (config.status === 'rejected') {
    return {
      exitCode: 2,
      stderr: `git push is blocked: could not read git's push configuration in ${dir} (${why(config.reason)}).\n`,
    };
  }
  const setting = configuredDelete(config.value, remotes);
  if (setting !== undefined) return { exitCode: 2, stderr: `${configuredPushBlocked(setting)}\n` };
  // What each push sends to its remote, against the personal denylist (ADR 0114); without one,
  // nothing runs. One scan for the command, with every remote it pushes to and every branch name
  // its refspecs create.
  const destinations = new Set(found.places.flatMap((each) => each.destinations));
  let denied: string | undefined;
  try {
    denied = await deniedPush(dir, [...remotes], [...destinations]);
  } catch (error) {
    denied = `git push is blocked: could not check it against your denylist (${why(error)}) (ADR 0114).`;
  }
  if (denied !== undefined) return { exitCode: 2, stderr: `${denied}\n` };
  // A stale tree fails the check deep in an import; say why in one line instead.
  const stale = await staleReason(dir);
  if (stale !== undefined) {
    return {
      exitCode: 2,
      stderr: `node_modules is out of date with package-lock.json (${stale}); run npm ci\n`,
    };
  }
  const { ok, output } = await runCheck(dir);
  if (ok) return { exitCode: 0, stderr: '' };
  return {
    exitCode: 2,
    stderr: `npm run check failed, so this command was blocked. Fix the failures and try again.\n\n${lastChars(output.trim())}\n`,
  };
};
