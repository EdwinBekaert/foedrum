// Git in a clone that attempt worktrees share (ADR 0096). Every worktree shares the clone's
// configuration, which a brewer can write, so the engine's git either runs elsewhere or turns off
// what a planted key could start: a network call runs in a git directory of Foedrum's own, with the
// clone's objects and the URL Foedrum names; a local one runs with no transport, hook or fsmonitor.

import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { devNull } from 'node:os';
import { join } from 'node:path';
import { removeTree } from '../platform/remove.ts';
import type { Git, GitOptions, GitResult } from './git.ts';

/**
 * The repository's remote as Foedrum names it, reached from git directories of Foedrum's own,
 * never through the clone's configuration (ADR 0090, ADR 0096).
 */
export interface OwnRemote {
  /** `https://github.com/<owner>/<name>.git`: the repository the pull request goes into. */
  url: string;
  /** The folder each call makes its git directory in, and removes it from after. */
  root: string;
  /** The name of each git directory; default a random UUID. */
  id?: () => string;
}

/**
 * What every local git call in the clone runs with: no transport, so a partial clone's lazy fetch
 * fails instead of reaching the clone's remote through its credential helper or ssh command; no
 * hook, such as reference-transaction on a ref update; no fsmonitor. An empty
 * `GIT_ALLOW_PROTOCOL` allows no protocol and no remote helper, whatever name it has, and
 * overrides every `protocol.<name>.allow` of the clone, which `protocol.allow` does not;
 * `GIT_NO_LAZY_FETCH` (git 2.44) makes the failure clear.
 */
const IN_CLONE = {
  env: { GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '' },
  config: { 'protocol.allow': 'never', 'core.hooksPath': devNull, 'core.fsmonitor': 'false' },
} as const satisfies GitOptions;

/** `git` whose calls run with `extra`'s environment and configuration over their own. */
export const gitWith =
  (git: Git, extra: GitOptions): Git =>
  (cwd, args, options = {}) =>
    git(cwd, args, {
      ...options,
      env: { ...options.env, ...extra.env },
      config: { ...options.config, ...extra.config },
    });

/** Local git in the clone (ADR 0096). */
export const inClone = (git: Git): Git => gitWith(git, IN_CLONE);

/** No hook, gc or maintenance in Foedrum's own git directory: a gc would prune the clone's objects. */
const OWN_CONFIG = { 'core.hooksPath': devNull, 'gc.auto': '0', 'maintenance.auto': 'false' };

/**
 * The URL Foedrum names as the promisor remote of its own git directory, for a partial clone: a
 * delta of a file the clone has no copy of then resolves from that URL, never through the clone's
 * configuration (review of #266).
 */
const PROMISOR = 'foedrum';
const FILTER = 'blob:none';

export const firstLine = ({ code, stderr }: GitResult): string =>
  stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== '') ??
  (code === null ? 'git did not finish in time' : `git exited with ${code}`);

/** The output of a git call that must succeed; git's first line of why, when it fails. */
export const gitOutput = async (
  git: Git,
  cwd: string,
  args: readonly string[],
  options?: GitOptions,
): Promise<string> => {
  const result = await git(cwd, args, options);
  if (result.code !== 0) {
    // The git command, after git's own options such as `--git-dir`.
    const command = args.find((arg) => !arg.startsWith('-')) ?? 'git';
    throw new Error(`git ${command} failed: ${firstLine(result)}`);
  }
  return result.stdout;
};

/** A git directory of Foedrum's own whose objects are the clone's. */
export interface OwnGitDir {
  /** The URL Foedrum names. */
  url: string;
  /** git in the directory; its output, or throws with git's reason. */
  run(args: readonly string[], options?: GitOptions): Promise<string>;
  /**
   * Fetches `refspec` from the URL Foedrum names, with nothing else: no tags, no FETCH_HEAD, no
   * submodules, no maintenance. Into a partial clone it fetches blobless, with that URL as the
   * directory's promisor remote. With `prune`, the refs `refspec` writes that the remote no longer
   * has go, before the fetch writes any.
   */
  fetch(refspec: string, timeoutMs: number, prune?: boolean): Promise<void>;
}

/**
 * Runs `use` with a git directory of its own, made for it in the remote's root and removed after,
 * also when it fails (ADR 0090): git there reads that directory's configuration and hooks, never
 * the clone's, and writes into the clone's object store (`<git-common-dir>/objects`, so the
 * clone's alternates still count). Nothing a call killed at its deadline left is read again.
 */
export const withOwnGitDir = async <T>(
  git: Git,
  clone: string,
  own: OwnRemote,
  signal: AbortSignal | undefined,
  use: (dir: OwnGitDir) => Promise<T>,
): Promise<T> => {
  const aborts: GitOptions = signal === undefined ? {} : { signal };
  const named = await gitOutput(
    inClone(git),
    clone,
    ['rev-parse', '--path-format=absolute', '--git-common-dir', '--show-object-format'],
    aborts,
  );
  const [common, format] = named.split(/\r?\n/);
  if (common === undefined || format === undefined || common === '' || format === '') {
    throw new Error(`git rev-parse did not name the git directory of ${clone}`);
  }
  const { url, root, id = randomUUID } = own;
  const gitDir = join(root, `${id()}.git`);
  const prefix = [`--git-dir=${gitDir}`];
  const run = (args: readonly string[], options: GitOptions = {}): Promise<string> =>
    gitOutput(git, root, [...prefix, ...args], {
      ...aborts,
      ...options,
      env: { ...options.env, GIT_OBJECT_DIRECTORY: join(common, 'objects') },
      config: { ...options.config, ...OWN_CONFIG },
    });
  const fetch = async (refspec: string, timeoutMs: number, prune = false): Promise<void> => {
    // A partial clone as the clone's configuration says: a promisor remote, or the extension older
    // gits write. One that says so falsely fetches no files, and one that hides it fails to fetch.
    const promisor = await inClone(git)(
      clone,
      ['config', '--get-regexp', String.raw`^(extensions\.partialclone|remote\..*\.promisor)$`],
      aborts,
    );
    const partial =
      promisor.code === 0 &&
      promisor.stdout
        .split(/\r?\n/)
        .some(
          (line) => /^extensions\.partialclone \S/i.test(line) || / (?:true|yes|on|1)$/i.test(line),
        );
    if (partial) {
      await run(['config', 'core.repositoryformatversion', '1']);
      await run(['config', 'extensions.partialClone', PROMISOR]);
    }
    await run(
      [
        'fetch',
        '--quiet',
        '--no-tags',
        '--no-write-fetch-head',
        '--no-recurse-submodules',
        // A gc there would prune every object of the clone that its own refs do not reach.
        '--no-auto-maintenance',
        ...(prune ? ['--prune'] : []),
        ...(partial ? [`--filter=${FILTER}`] : []),
        '--end-of-options',
        partial ? PROMISOR : url,
        refspec,
      ],
      {
        timeoutMs,
        config: partial
          ? {
              [`remote.${PROMISOR}.url`]: url,
              [`remote.${PROMISOR}.promisor`]: 'true',
              [`remote.${PROMISOR}.partialclonefilter`]: FILTER,
            }
          : {},
      },
    );
  };
  try {
    // git init makes the directory, but not the folder it is in.
    await mkdir(root, { recursive: true });
    await gitOutput(
      git,
      root,
      [...prefix, 'init', '--bare', '--quiet', '--template=', `--object-format=${format}`],
      aborts,
    );
    return await use({ url, run, fetch });
  } finally {
    await removeTree(gitDir);
  }
};

/** One `<sha> <ref>` line per ref, as `for-each-ref --format=%(objectname) %(refname)` prints. */
const refsOf = (listed: string): Map<string, string> => {
  const refs = new Map<string, string>();
  for (const line of listed.split(/\r?\n/)) {
    const space = line.indexOf(' ');
    if (space > 0) refs.set(line.slice(space + 1), line.slice(0, space));
  }
  return refs;
};

const updates = (refs: Iterable<[string, string]>): string =>
  [...refs].map(([ref, sha]) => `update ${ref} ${sha}\n`).join('');

/**
 * The worktree manager's fetch (ADR 0096): every branch of the remote Foedrum names into the
 * clone's `refs/remotes/<remote>/`, as `git fetch --prune <remote>` would, but from a git directory
 * of its own. Its refs start as the clone's, so the server sends only what the clone lacks and
 * git's check of what came stops there. The refs the remote no longer has are deleted from the
 * clone first, then the refs that moved are written back, so a branch made again as a folder (`x`
 * gone, `x/y` new) never stops the fetch (review of #266). `<remote>/HEAD`, which no branch of the
 * remote writes, stays.
 */
export const fetchIntoClone = async (
  git: Git,
  clone: string,
  own: OwnRemote,
  options: { remote: string; timeoutMs: number },
): Promise<void> => {
  const { remote, timeoutMs } = options;
  const local = inClone(git);
  const tracking = `refs/remotes/${remote}/`;
  const listing = ['for-each-ref', '--format=%(objectname) %(refname)', tracking];
  await withOwnGitDir(git, clone, own, undefined, async (dir) => {
    const known = refsOf(await gitOutput(local, clone, listing));
    if (known.size > 0) await dir.run(['update-ref', '--stdin'], { stdin: updates(known) });
    await dir.fetch(`+refs/heads/*:${tracking}*`, timeoutMs, true);
    const fetched = refsOf(await dir.run(listing));
    // Each deleted only while it is where the clone had it, and before the updates: git refuses to
    // delete `x` and make `x/y` in one transaction.
    const gone = [...known]
      .filter(([ref]) => !fetched.has(ref) && ref !== `${tracking}HEAD`)
      .map(([ref, sha]) => `delete ${ref} ${sha}\n`);
    if (gone.length > 0) {
      await gitOutput(local, clone, ['update-ref', '--stdin'], { stdin: gone.join('') });
    }
    const moved = [...fetched].filter(([ref, sha]) => known.get(ref) !== sha);
    if (moved.length > 0) {
      await gitOutput(local, clone, ['update-ref', '--stdin'], { stdin: updates(moved) });
    }
  });
};
