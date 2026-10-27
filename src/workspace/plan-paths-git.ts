// The paths of a plan read at a commit (ADR 0233), the shell: `git ls-tree` in the clone, which
// reads trees only, so a blob-less clone fetches nothing. Git runs only through the injected
// `Git`, so unit tests pass a fake one (ADR 0021).

import type { PathsRead, ReadPaths } from '../engine/plan-touches.ts';
import { RelativePath } from '../schemas/primitives.ts';
import { firstLine, inClone } from './clone-git.ts';
import type { Git } from './git.ts';

// A full sha, SHA-1 or SHA-256, so that nothing reaches git as an option or a revision expression.
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** The most characters of paths one call gives git: Windows' command line holds 32,767. */
const MOST_PATH_CHARS = 24_000;

/** `paths` in runs of at most `MOST_PATH_CHARS` characters, each with at least one path. */
const runsOf = (paths: readonly string[]): string[][] => {
  const runs: string[][] = [];
  let run: string[] = [];
  let size = 0;
  for (const path of paths) {
    if (run.length > 0 && size + path.length + 1 > MOST_PATH_CHARS) {
      runs.push(run);
      run = [];
      size = 0;
    }
    run.push(path);
    size += path.length + 1;
  }
  return run.length === 0 ? runs : [...runs, run];
};

export const readPathsAt =
  (shared: Git): ReadPaths =>
  async (clone, commit, paths, signal): Promise<PathsRead> => {
    if (!SHA.test(commit)) return { kind: 'unread', reason: `${commit} is no full commit sha` };
    const unsafe = paths.find((path) => !RelativePath.safeParse(path).success);
    if (unsafe !== undefined) {
      return { kind: 'unread', reason: `${JSON.stringify(unsafe)} is no relative path` };
    }
    // No hook or fsmonitor of the clone's runs in the engine's git (ADR 0137).
    const git = inClone(shared);
    // The paths as written: no `*`, `?` or `[` read as a pattern.
    const options = {
      env: { GIT_LITERAL_PATHSPECS: '1' },
      ...(signal === undefined ? {} : { signal }),
    };
    const present = new Set<string>();
    for (const run of runsOf(paths)) {
      // -t lists each folder on the way to a path, and the path itself when it is a folder.
      const listed = await git(
        clone,
        ['ls-tree', '-t', '--name-only', '-z', commit, '--', ...run],
        options,
      );
      if (listed.code !== 0) {
        return { kind: 'unread', reason: `git ls-tree failed: ${firstLine(listed)}` };
      }
      for (const name of listed.stdout.split('\0')) if (name !== '') present.add(name);
    }
    return { kind: 'read', present };
  };
