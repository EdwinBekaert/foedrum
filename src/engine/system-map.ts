// The system map (ADR 0317): what each repository of the Brewery publishes and which other one it
// depends on, read from its manifests at its base with git and no model, and written as the lines
// the planners' repositories input and `foedrum doctor` show. Each ecosystem is one reader in
// `READERS`; the core knows none of them.

import { dotnetManifest } from '../formats/dotnet-manifest.ts';
import type { DependencyVia, ManifestReader } from '../formats/manifest-reader.ts';
import { npmManifest } from '../formats/npm-manifest.ts';
import { MAX_MAP_ITEMS, MAX_MAP_NAME_LENGTH, type SystemMapEntry } from '../schemas/system-map.ts';
import type { Git, GitResult } from '../workspace/git.ts';
import { sameRepo } from './task-tree.ts';

/** The readers the map runs over each repository's files, in order. */
export const READERS: readonly ManifestReader[] = [npmManifest, dotnetManifest];

/** The most manifests read in one repository; the rest are counted as left out. */
const MAX_MANIFESTS = 64;
/** The largest manifest read. */
const MAX_MANIFEST_BYTES = 1024 * 1024;
/** The longest listing of a repository's files git may write. */
const MAX_LISTING_BYTES = 16 * 1024 * 1024;
const READ_MS = 30_000;

/**
 * `text` as one line of at most `MAX_MAP_NAME_LENGTH` characters: line breaks and control
 * characters become spaces and a backtick a quote, so a manifest's text cannot forge a line or end
 * a name's quotes; empty stays empty.
 */
export const mapName = (text: string): string => {
  const line = text
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ')
    .replaceAll('`', "'")
    .trim();
  return line.length > MAX_MAP_NAME_LENGTH ? `${line.slice(0, MAX_MAP_NAME_LENGTH - 1)}…` : line;
};

/** A manifest as git gave it: its text, or why it could not be read. */
export type ManifestFile = { path: string } & ({ text: string } | { unread: string });

const cleanVia = (via: DependencyVia): SystemMapEntry['dependsOn'][number]['via'] | undefined => {
  switch (via.kind) {
    case 'package': {
      const version = via.version === undefined ? '' : mapName(via.version);
      return { kind: 'package', ...(version === '' ? {} : { version }) };
    }
    case 'git': {
      const url = mapName(via.url);
      const ref = via.ref === undefined ? '' : mapName(via.ref);
      return url === '' ? undefined : { kind: 'git', url, ...(ref === '' ? {} : { ref }) };
    }
    case 'project': {
      const path = mapName(via.path);
      return path === '' ? undefined : { kind: 'project', path };
    }
    default: {
      const unknown: never = via;
      throw new Error(`unknown dependency ${JSON.stringify(unknown)}`);
    }
  }
};

/**
 * A repository's entry from its manifests and its test map's modules: each manifest, with its
 * ecosystem, read by the first reader that matches it, every value cut to a line, each list to
 * `MAX_MAP_ITEMS`, with what that left out counted. Pure.
 */
export const entryOf = (
  files: readonly ManifestFile[],
  modules: readonly string[],
  leftFiles = 0,
): SystemMapEntry => {
  const manifests: NonNullable<SystemMapEntry['manifests']> = [];
  const publishes: SystemMapEntry['publishes'] = [];
  const dependsOn: SystemMapEntry['dependsOn'] = [];
  const unreadable: SystemMapEntry['unreadable'] = [];
  for (const file of files) {
    const reader = READERS.find((each) => each.matches(file.path));
    if (reader === undefined) continue;
    const path = mapName(file.path);
    manifests.push({ path, ecosystem: reader.ecosystem });
    const read = 'text' in file ? reader.read(file.path, file.text) : undefined;
    if (read === undefined || read.kind === 'unreadable') {
      const reason = mapName(read?.reason ?? ('unread' in file ? file.unread : ''));
      unreadable.push({ path, reason: reason === '' ? 'no reason given' : reason });
      continue;
    }
    const ecosystem = reader.ecosystem;
    for (const name of read.publishes.map(mapName).filter((each) => each !== '')) {
      publishes.push({ name, ecosystem });
    }
    for (const dependency of read.dependsOn) {
      const name = mapName(dependency.name);
      const via = cleanVia(dependency.via);
      if (name !== '' && via !== undefined) dependsOn.push({ name, ecosystem, via });
    }
  }
  const named = modules.map(mapName).filter((each) => each !== '');
  const lists = [manifests, publishes, dependsOn, named, unreadable];
  const left =
    leftFiles + lists.reduce((sum, list) => sum + Math.max(0, list.length - MAX_MAP_ITEMS), 0);
  return {
    manifests: manifests.slice(0, MAX_MAP_ITEMS),
    publishes: publishes.slice(0, MAX_MAP_ITEMS),
    dependsOn: dependsOn.slice(0, MAX_MAP_ITEMS),
    modules: named.slice(0, MAX_MAP_ITEMS),
    unreadable: unreadable.slice(0, MAX_MAP_ITEMS),
    ...(left === 0 ? {} : { left }),
  };
};

/** Whether git was stopped or timed out: a read that may pass when it is tried again. */
const cutShort = ({ killed }: GitResult): boolean => killed === 'timed-out' || killed === 'stopped';

const gitWhy = (result: GitResult): string =>
  result.stderr.trim().split('\n').at(-1)?.trim() || `git exited with ${result.code ?? 'no code'}`;

/**
 * The manifests of the repository in `clone` at `commit`, read with git alone: `ls-tree` lists its
 * files, `cat-file` reads each one a reader matches, at most `MAX_MANIFESTS` of them. Throws when
 * git cannot list the commit; when git was stopped or timed out, which a later read may not be, it
 * gives why instead, and the map is not recorded.
 */
export const manifestsAt =
  (git: Git) =>
  async (
    clone: string,
    commit: string,
    signal?: AbortSignal,
  ): Promise<{ files: ManifestFile[]; left: number } | { again: string }> => {
    const options = { timeoutMs: READ_MS, ...(signal === undefined ? {} : { signal }) };
    const listing = await git(
      clone,
      ['ls-tree', '-r', '-z', '--full-tree', '--name-only', commit],
      { ...options, maxOutputBytes: MAX_LISTING_BYTES },
    );
    if (cutShort(listing)) return { again: `git did not list ${commit}: ${gitWhy(listing)}` };
    if (listing.code !== 0) throw new Error(`git could not list ${commit}: ${gitWhy(listing)}`);
    const paths = listing.stdout
      .split('\0')
      .filter((path) => path !== '' && READERS.some((reader) => reader.matches(path)));
    const files: ManifestFile[] = [];
    for (const path of paths.slice(0, MAX_MANIFESTS)) {
      const read = await git(clone, ['cat-file', 'blob', `${commit}:${path}`], {
        ...options,
        maxOutputBytes: MAX_MANIFEST_BYTES,
      });
      if (cutShort(read)) return { again: `git did not read ${path}: ${gitWhy(read)}` };
      files.push(
        read.code === 0
          ? { path, text: read.stdout }
          : read.killed === 'too-much-output'
            ? { path, unread: `it is larger than ${MAX_MANIFEST_BYTES} bytes` }
            : { path, unread: `git could not read it: ${gitWhy(read)}` },
      );
    }
    return { files, left: Math.max(0, paths.length - MAX_MANIFESTS) };
  };

/** A repository of the Brewery as the map names it, with its entry when one is recorded. */
export interface MappedRepository {
  repo: string;
  description?: string;
  entry?: SystemMapEntry;
}

/** The repository of `others` a git URL names: its last two path segments, `.git` dropped. */
const repoOfUrl = (url: string, others: readonly MappedRepository[]): string | undefined => {
  const parts = url
    .replace(/\.git$/i, '')
    .split(/[/:]/)
    .filter((part) => part !== '');
  const named = parts.slice(-2).join('/');
  return others.find(({ repo }) => sameRepo(repo, named))?.repo;
};

/** The repository of `others` a project path out of the repository names by its first folder. */
const repoOfPath = (path: string, others: readonly MappedRepository[]): string | undefined => {
  const parts = path.split('/');
  const out = parts.findIndex((part) => part !== '..');
  if (out <= 0) return undefined;
  const folder = (parts[out] ?? '').toLowerCase();
  return others.find(({ repo }) => repo.split('/').at(-1)?.toLowerCase() === folder)?.repo;
};

/** The other repository a dependency comes from, or undefined when it names none of them. */
const fromRepo = (
  dependency: SystemMapEntry['dependsOn'][number],
  others: readonly MappedRepository[],
): string | undefined => {
  const { via, name, ecosystem } = dependency;
  switch (via.kind) {
    case 'git':
      return repoOfUrl(via.url, others);
    case 'project':
      return repoOfPath(via.path, others);
    case 'package':
      return others.find(({ entry }) =>
        // npm names are lower case, and NuGet's ids match in any case.
        entry?.publishes.some(
          (each) => each.name.toLowerCase() === name.toLowerCase() && each.ecosystem === ecosystem,
        ),
      )?.repo;
    default: {
      const unknown: never = via;
      throw new Error(`unknown dependency ${JSON.stringify(unknown)}`);
    }
  }
};

const byWhat = (via: SystemMapEntry['dependsOn'][number]['via']): string => {
  switch (via.kind) {
    case 'git':
      return via.ref === undefined ? `by git URL \`${via.url}\`` : `by git ref \`${via.ref}\``;
    case 'project':
      return `by project reference \`${via.path}\``;
    case 'package':
      return via.version === undefined ? 'by package reference' : `by version \`${via.version}\``;
    default: {
      const unknown: never = via;
      throw new Error(`unknown dependency ${JSON.stringify(unknown)}`);
    }
  }
};

/**
 * The lines the map gives `repository` among `all`, each without its indent: its description, its
 * manifests with their ecosystems, what it publishes, each dependency on another repository of the Brewery, its test map's modules,
 * each manifest that could not be read, and how much its entry left out.
 */
export const mapLines = (
  repository: MappedRepository,
  all: readonly MappedRepository[],
): string[] => {
  const { description, entry } = repository;
  const lines = description === undefined ? [] : [mapName(description)];
  if (entry === undefined) return lines;
  const manifests = (entry.manifests ?? []).map(({ path, ecosystem }) => `${path} (${ecosystem})`);
  if (manifests.length > 0) lines.push(`manifests: ${manifests.join(', ')}`);
  const others = all.filter(({ repo }) => !sameRepo(repo, repository.repo));
  for (const { name, ecosystem } of entry.publishes)
    lines.push(`publishes \`${name}\` (${ecosystem})`);
  for (const dependency of entry.dependsOn) {
    const from = fromRepo(dependency, others);
    if (from === undefined) continue;
    lines.push(
      `depends on \`${dependency.name}\` from ${from} ${byWhat(dependency.via)} (${dependency.ecosystem})`,
    );
  }
  if (entry.modules.length > 0) lines.push(`test map modules: ${entry.modules.join(', ')}`);
  for (const { path, reason } of entry.unreadable) {
    lines.push(`\`${path}\` could not be read: ${reason}`);
  }
  if (entry.left !== undefined) lines.push(`${entry.left} more manifests or entries left out`);
  return lines;
};

/** The most characters the map adds to the planners' repositories input. */
export const MAX_MAP_CHARACTERS = 1500;

/**
 * Each repository's line followed by its map lines indented, the map lines kept while their
 * characters fit in `max`; the repository lines are always kept. When lines are left out, the last
 * line says how many and how many characters, and where the whole map is.
 */
export const cappedMap = (
  blocks: readonly { line: string; map: readonly string[] }[],
  max = MAX_MAP_CHARACTERS,
): string[] => {
  let used = 0;
  let leftLines = 0;
  let leftCharacters = 0;
  const lines: string[] = [];
  for (const { line, map } of blocks) {
    lines.push(line);
    for (const each of map) {
      const indented = `  ${each}`;
      if (leftLines === 0 && used + indented.length + 1 <= max) {
        used += indented.length + 1;
        lines.push(indented);
      } else {
        leftLines += 1;
        leftCharacters += indented.length + 1;
      }
    }
  }
  if (leftLines > 0) {
    lines.push(
      `(${leftLines} lines of the system map left out, ${leftCharacters} characters: foedrum doctor shows it whole)`,
    );
  }
  return lines;
};
