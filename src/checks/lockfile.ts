// The lockfile a release bump leaves behind (ADR 0412): after a brewer's attempt in a batch that
// waited for a release ends with commits, Foedrum refreshes the lockfiles those commits left behind,
// with the package manager in the setup's sandbox, and commits it on the attempt's
// branch: npm's `package-lock.json` beside a changed `package.json`, Cargo's nearest `Cargo.lock`
// from a changed `Cargo.toml` up, and NuGet's `packages.lock.json` beside a changed .NET project or
// beside each project below a changed `Directory.Packages.props` (ADR 0415).

import { lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Env } from '../engine/brewer-env.ts';
import { cargoManifest } from '../formats/cargo-manifest.ts';
import { PROJECT } from '../formats/dotnet-manifest.ts';
import { fileName, inBuiltFolder } from '../formats/manifest-reader.ts';
import { npmManifest } from '../formats/npm-manifest.ts';
import { pathInside } from '../platform/paths.ts';
import type { ExecProcess } from '../platform/processes.ts';
import { realPath } from '../platform/real-path.ts';
import type { GravityReading } from '../schemas/events.ts';
import { passed } from './gravity.ts';
import { readingOn, runLine, SAFE_PATH } from './setup.ts';

/** The command that refreshes an npm lockfile from its manifest, running no package's scripts. */
export const NPM_REFRESH = 'npm install --package-lock-only --ignore-scripts';

/** The command that refreshes a Cargo workspace's lockfile after its manifests' versions changed. */
export const CARGO_REFRESH = 'cargo update --workspace';

/** The command that restores a .NET project, which refreshes its lockfile when its packages changed. */
export const NUGET_REFRESH = 'dotnet restore';

/** How long one refresh may run, unless the attempt's deadline comes sooner. */
export const REFRESH_TIMEOUT_MS = 300_000;

/** One lockfile to refresh: its folder, the file, both relative with forward slashes, and how. */
export interface LockfileRefresh {
  folder: string;
  lockfile: string;
  command: string;
  /**
   * Where else the lockfile is: the nearest of its name from the folder up (`above`), or beside
   * each project in the folders below, the command naming that project (`below`).
   */
  find?: 'above' | 'below';
}

/** The lockfiles to refresh for the `changed` paths of an attempt's commits. */
export function lockfileRefreshes(changed: readonly string[]): LockfileRefresh[] {
  // A brewer names the paths: one whose name would break a reading's line is left out.
  return changed
    .filter((path) => !ONE_LINE_BREAKER.test(path))
    .flatMap((manifest): LockfileRefresh[] => {
      const folder = folderOf(manifest);
      const name = fileName(manifest);
      if (npmManifest.matches(manifest)) {
        return [{ folder, lockfile: inFolder(folder, NPM_LOCKFILE), command: NPM_REFRESH }];
      }
      if (cargoManifest.matches(manifest)) {
        const lockfile = inFolder(folder, CARGO_LOCKFILE);
        return [{ folder, lockfile, command: CARGO_REFRESH, find: 'above' }];
      }
      if (inBuiltFolder(manifest)) return [];
      // A folder may hold a solution beside the project: restore names the one that changed.
      if (PROJECT.test(name)) {
        const command = restoring(name);
        if (command === undefined) return [];
        return [{ folder, lockfile: inFolder(folder, NUGET_LOCKFILE), command }];
      }
      if (name === CENTRAL_PACKAGES) {
        const lockfile = inFolder(folder, NUGET_LOCKFILE);
        return [{ folder, lockfile, command: NUGET_REFRESH, find: 'below' }];
      }
      return [];
    });
}

const NPM_LOCKFILE = 'package-lock.json';
const CARGO_LOCKFILE = 'Cargo.lock';
const NUGET_LOCKFILE = 'packages.lock.json';
/** The file of central package versions, which MSBuild imports into each project below it. */
const CENTRAL_PACKAGES = 'Directory.Packages.props';

/** The folders a walk for projects passes over: built or installed files, and git's own. */
const UNWALKED: ReadonlySet<string> = new Set(['bin', 'obj', 'node_modules', '.git']);

/** The folder of a path relative with forward slashes, '' at the root. */
const folderOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf('/')));

/** `name` in the relative `folder`. */
const inFolder = (folder: string, name: string): string =>
  folder === '' ? name : `${folder}/${name}`;

/** `dotnet restore` of the project `name` in its folder, or undefined for a name it cannot quote. */
const restoring = (name: string): string | undefined =>
  SAFE_PATH.test(name) ? `${NUGET_REFRESH} "${name}"` : undefined;

/** A control character or a line or paragraph separator. */
const ONE_LINE_BREAKER = new RegExp(
  String.raw`[\p{Cc}${String.fromCodePoint(0x2028, 0x2029)}]`,
  'u',
);

/** The bytes of `file` when it is a regular file inside `tree`, through no link; else undefined. */
const regularFile = async (tree: string, file: string): Promise<Buffer | undefined> => {
  const found = await lstat(file).catch(() => undefined);
  if (found?.isFile() !== true) return undefined;
  if (pathInside(realPath(tree), realPath(file)) === undefined) return undefined;
  return readFile(file);
};

/** The path in `tree` of `relative`, a path relative with forward slashes. */
const inTree = (tree: string, relative: string): string => join(tree, ...relative.split('/'));

/**
 * The lockfiles `refresh` names in `tree`: itself, the nearest of its name from its folder up
 * (`above`), or each beside the one project of a folder below, which the command names (`below`).
 */
const found = async (tree: string, refresh: LockfileRefresh): Promise<LockfileRefresh[]> => {
  const { folder, lockfile, command, find } = refresh;
  const name = fileName(lockfile);
  switch (find) {
    case undefined:
      return [refresh];
    case 'above':
      for (let at = folder; ; at = folderOf(at)) {
        const here = inFolder(at, name);
        if ((await regularFile(tree, inTree(tree, here))) !== undefined) {
          return [{ folder: at, lockfile: here, command }];
        }
        if (at === '') return [];
      }
    case 'below': {
      const refreshes: LockfileRefresh[] = [];
      const walk = async (at: string): Promise<void> => {
        // A folder it cannot read fails the refresh, rather than leave its lockfile stale unseen.
        const entries = await readdir(inTree(tree, at), { withFileTypes: true });
        entries.sort((a, b) => (a.name < b.name ? -1 : 1));
        const files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
        const projects = files.filter((file) => PROJECT.test(file));
        const here = inFolder(at, name);
        const restore = projects.length === 1 ? restoring(projects[0] ?? '') : undefined;
        if (files.includes(name) && restore !== undefined && !ONE_LINE_BREAKER.test(here)) {
          refreshes.push({ folder: at, lockfile: here, command: restore });
        }
        // A link, a junction among them, is no directory here: the walk stays in the tree.
        for (const entry of entries) {
          if (entry.isDirectory() && !UNWALKED.has(entry.name.toLowerCase())) {
            await walk(inFolder(at, entry.name));
          }
        }
      };
      await walk(folder);
      return refreshes;
    }
    default: {
      const unhandled: never = find;
      throw new Error(`Unhandled find ${JSON.stringify(unhandled)}`);
    }
  }
};

/** Where and how the refreshes run: the setup's process runner, environment and deadline. */
export interface RefreshRun {
  exec: ExecProcess;
  env: Env;
  deadlineAt: string;
  now: () => Date;
  signal: AbortSignal;
  /** Whether no sandbox holds it: on native Windows (ADR 0158). */
  unsandboxed: boolean;
}

/** What the refreshes in a tree read, and the lockfiles they changed. */
export interface LockfilesRefreshed {
  readings: GravityReading[];
  files: string[];
}

/**
 * Runs each refresh whose lockfile the tree `worktree` holds as a regular file, in its folder,
 * until one does not pass; the lockfiles they changed, none when one did not pass.
 */
export async function refreshLockfiles(
  worktree: string,
  refreshes: readonly LockfileRefresh[],
  run: RefreshRun,
): Promise<LockfilesRefreshed> {
  const { exec, env, deadlineAt, now, signal, unsandboxed } = run;
  const readings: GravityReading[] = [];
  const files: string[] = [];
  const named: LockfileRefresh[] = [];
  for (const refresh of refreshes) named.push(...(await found(worktree, refresh)));
  // A lockfile two manifests lead to, such as a workspace's for two members, is refreshed once.
  const once = named.filter(
    ({ lockfile }, at) => named.findIndex((other) => other.lockfile === lockfile) === at,
  );
  for (const { folder, lockfile, command } of once) {
    const file = inTree(worktree, lockfile);
    // A repository that keeps no lockfile there has none to refresh.
    const before = await regularFile(worktree, file);
    if (before === undefined) continue;
    const cwd = inTree(worktree, folder);
    const timeoutMs = REFRESH_TIMEOUT_MS;
    const result = await runLine(exec, command, { cwd, env, deadlineAt, now, signal, timeoutMs });
    const reading = { ...readingOn({ kind: 'run', command }, result, unsandboxed), lockfile };
    readings.push(reading);
    // Nothing is committed unless every refresh passed: the attempt then ends blocked, and a
    // retry resumes in its worktree, which must not lag behind its branch (ADR 0117, ADR 0412).
    if (!passed(reading)) return { readings, files: [] };
    const after = await regularFile(worktree, file);
    if (after !== undefined && !after.equals(before)) files.push(lockfile);
  }
  return { readings, files };
}
