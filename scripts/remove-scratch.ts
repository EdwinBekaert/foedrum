// `node scripts/remove-scratch.ts <scratch>`: removes a brew-review scratch folder through the
// platform removal, which clears read-only bits and retries busy files (issue #61). The scratch
// tree is a clone; a record under .git/worktrees/ that still points at it, left by a run from
// when it was a worktree, goes too. remove-scratch/core.ts decides; no other record is touched.
// Exits 1 when it refuses the folder or could not remove something.

import { realpath } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { removeTree } from '../src/platform/remove.ts';
import { readRecords } from '../src/workspace/worktree-records.ts';
import { planScratch } from './remove-scratch/core.ts';
import { type Git, runGit } from './worktrees-clean.ts';

export const removeScratch = async (
  cwd: string,
  scratch: string,
  git: Git = runGit,
  remove: (path: string) => Promise<void> = removeTree,
): Promise<{ ok: boolean; lines: string[] }> => {
  const args = ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'];
  const dirs = await git(cwd, args);
  const [checkout, commonDir] = dirs.stdout.split(/\r?\n/);
  if (!dirs.ok || !checkout || !commonDir) {
    return { ok: false, lines: ['refused: not inside a git repository'] };
  }
  // The working directory, the checkout git prints and the folders git wrote into the records
  // may each go through a junction, link or subst drive; compare them in their real form.
  const real = (path: string): Promise<string> => realpath(path).catch(() => path);
  const folder = resolve(await real(cwd), scratch);
  const decided = planScratch({
    checkout: await real(checkout),
    scratch: folder,
    records: await Promise.all(
      (await readRecords(commonDir)).map(async (record) =>
        record.folder === undefined ? record : { ...record, folder: await real(record.folder) },
      ),
    ),
  });
  if (!decided.ok) return { ok: false, lines: [`refused: ${decided.reason}`] };

  const targets = [
    { path: folder, label: folder },
    ...decided.records.map((path) => ({
      path,
      label: `worktree record .git/worktrees/${basename(path)}`,
    })),
  ];
  const lines: string[] = [];
  for (const { path, label } of targets) {
    try {
      await remove(path);
      lines.push(`removed ${label}`);
    } catch (error) {
      lines.push(`could not remove ${label}: ${(error as Error).message}`);
    }
  }
  return { ok: lines.every((line) => line.startsWith('removed ')), lines };
};

if (import.meta.main) {
  const [scratch] = process.argv.slice(2);
  if (scratch === undefined) {
    console.error('usage: node scripts/remove-scratch.ts <scratch folder>');
    process.exitCode = 2;
  } else {
    const { ok, lines } = await removeScratch(process.cwd(), scratch);
    for (const line of lines) console.log(`remove-scratch: ${line}`);
    if (!ok) process.exitCode = 1;
  }
}
