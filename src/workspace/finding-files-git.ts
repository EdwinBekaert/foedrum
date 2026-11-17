// The files a Taster's findings cite, read at the commit it reviewed (ADR 0421), the shell: `git
// ls-tree` and `git cat-file` in the clone, never the worktree, which the brewer can write. The
// worktree checked that commit out, so its files are in the clone. Git runs only through the
// injected `Git`, so unit tests pass a fake one (ADR 0021).

import type { FilesRead, ReadFiles } from '../engine/finding-places.ts';
import { RelativePath } from '../schemas/primitives.ts';
import { isCommitSha, noCommitSha } from '../schemas/store.ts';
import { inClone } from './clone-git.ts';
import { type Git, gitFailure } from './git.ts';
import { runsOf } from './plan-paths-git.ts';

/** A link is a blob too, but no file a line can be in. */
const LINK_MODE = '120000';

export const readFilesAt =
  (shared: Git): ReadFiles =>
  async (clone, commit, paths, signal): Promise<FilesRead> => {
    // A full sha, so that nothing reaches git as an option or a revision expression.
    if (!isCommitSha(commit)) return { kind: 'unread', reason: noCommitSha(commit) };
    // A path that is no relative path, a glob or a name Windows refuses, is no file of the tree:
    // it never reaches git, and the others are still read.
    const relative = paths.filter((path) => RelativePath.safeParse(path).success);
    // No hook or fsmonitor of the clone's runs in the engine's git (ADR 0137).
    const git = inClone(shared);
    const options = signal === undefined ? {} : { signal };
    // The object of each path that is a regular file: `<mode> <type> <object>\t<path>`.
    const objects = new Map<string, string>();
    for (const run of runsOf(relative)) {
      // The paths as written: no `*`, `?` or `[` read as a pattern.
      const listed = await git(clone, ['ls-tree', '-z', commit, '--', ...run], {
        ...options,
        env: { GIT_LITERAL_PATHSPECS: '1' },
      });
      if (listed.code !== 0) {
        return { kind: 'unread', reason: `git ls-tree failed: ${gitFailure(listed)}` };
      }
      for (const entry of listed.stdout.split('\0')) {
        const tab = entry.indexOf('\t');
        const [mode, type, object] = entry.slice(0, tab).split(' ');
        if (tab < 0 || type !== 'blob' || mode === LINK_MODE || object === undefined) continue;
        objects.set(entry.slice(tab + 1), object);
      }
    }
    const files = new Map<string, string | undefined>();
    for (const path of paths) {
      const object = objects.get(path);
      if (object === undefined) {
        files.set(path, undefined);
        continue;
      }
      const shown = await git(clone, ['cat-file', 'blob', object], options);
      if (shown.code !== 0) {
        return { kind: 'unread', reason: `git cat-file failed: ${gitFailure(shown)}` };
      }
      files.set(path, shown.stdout);
    }
    return { kind: 'read', files };
  };
