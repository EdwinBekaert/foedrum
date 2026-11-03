// `foedrum doctor`'s system map (ADR 0317): each repository of foedrum.jsonc read in its clone at
// `origin/<base>` with the readers the planners' map is recorded with, so a person sees what they
// read, and at which commit.

import { join } from 'node:path';
import { breweryMapPath, testMaps } from '../checks/test-map.ts';
import { entryOf, gitWhy, manifestsAt, modulesOf } from '../engine/system-map.ts';
import { messageOf } from '../platform/errors.ts';
import { BreweryConfig } from '../schemas/brewery-config.ts';
import { readJsonc } from '../schemas/read.ts';
import type { SystemMapEntry } from '../schemas/system-map.ts';
import type { Git } from '../workspace/git.ts';
import { attemptClone } from './serve-config.ts';

/** A repository of the map as doctor read it: its entry at a commit, or why it could not. */
export interface DoctorMapRepository {
  repo: string;
  base: string;
  description?: string;
  read: { commit: string; entry: SystemMapEntry } | { unread: string };
}

export interface DoctorMapSources {
  git: Git;
  home: string;
  cwd: string;
  /** The text of the file at `path`, or undefined when there is none. */
  readFile: (path: string) => string | undefined;
  /** Whether a clone is there to read. */
  exists: (path: string) => boolean;
}

/** Each repository of the Brewery's foedrum.jsonc, read at its base; none without a readable one. */
export const readDoctorMap = async (sources: DoctorMapSources): Promise<DoctorMapRepository[]> => {
  const { git, home, cwd, readFile, exists } = sources;
  const files = {
    config: readFile(join(cwd, 'foedrum.jsonc')),
    local: readFile(join(cwd, '.foedrum', 'local.jsonc')),
  };
  if (files.config === undefined) return [];
  const read = readJsonc(files.config, BreweryConfig);
  if (!read.valid) return [];
  const repositories = Object.entries(read.value.repositories);
  const clones = new Map(repositories.map(([repo]) => [repo, attemptClone(files, home, repo)]));
  const mapAt = testMaps({
    git,
    clone: (repo) => clones.get(repo) ?? cwd,
    keptIn: (repo) => (read.value.repositories[repo]?.testMap === 'brewery' ? 'brewery' : 'repo'),
    brewery: (repo) => readFile(join(cwd, breweryMapPath(repo))),
  });
  return Promise.all(
    repositories.map(async ([repo, repository]): Promise<DoctorMapRepository> => {
      const base = `origin/${repository.base ?? 'main'}`;
      const named = {
        repo,
        base,
        ...(repository.description === undefined ? {} : { description: repository.description }),
      };
      const clone = clones.get(repo);
      if (clone === undefined || !exists(clone)) {
        return { ...named, read: { unread: 'it has no clone here yet' } };
      }
      try {
        const args = ['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`];
        const resolved = await git(clone, args, { timeoutMs: 10_000 });
        const commit = resolved.stdout.trim();
        // A base git was stopped on is not said to be missing.
        if (resolved.killed !== undefined) {
          return {
            ...named,
            read: { unread: `git could not resolve ${base}: ${gitWhy(resolved)}` },
          };
        }
        if (resolved.code !== 0 || commit === '') {
          return { ...named, read: { unread: `its clone has no ${base}` } };
        }
        const manifests = await manifestsAt(git)(clone, commit);
        if ('again' in manifests) return { ...named, read: { unread: manifests.again } };
        const modules = modulesOf(await mapAt(repo, commit));
        const entry = entryOf(manifests.files, modules, manifests.left);
        return { ...named, read: { commit, entry } };
      } catch (error) {
        return { ...named, read: { unread: messageOf(error) } };
      }
    }),
  );
};
