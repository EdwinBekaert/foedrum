// `node scripts/remove-scratch.ts <scratch>`: removes a brew-review scratch folder and the record
// under .git/worktrees/ of its tree through the platform removal, which clears the read-only
// bits git trips over on Windows (issue #61). remove-scratch/core.ts decides which records are
// the tree's; no other record is touched. Exits 1 when something could not be removed.

import { readFile, realpath } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { removeTree } from '../src/platform/remove.ts';
import { planScratch } from './remove-scratch/core.ts';
import { readRecords } from './worktrees-clean/records.ts';
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
    dotGit: await readFile(join(folder, 'tree', '.git'), 'utf8').catch(() => undefined),
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
