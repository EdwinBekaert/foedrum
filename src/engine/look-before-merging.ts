// What a person should look at before merging (ADR 0384): the changes of a kind they should always
// see, found once at the push by fixed checks on the change's files and manifests, never by a
// model, and shown as one line of the merge brief. It informs only: nothing reads it to block.

import {
  type DependencyVia,
  fileName,
  inFolderNamed,
  type ManifestReader,
} from '../formats/manifest-reader.ts';
import type {
  DependencyChange,
  LookBeforeMerging,
  PushResult,
  SensitiveFiles,
} from '../schemas/store.ts';
import { MAX_SENSITIVE } from '../schemas/store.ts';
import { code, plain, shortSha } from './status-comment.ts';
import { mapName, READERS } from './system-map.ts';

/** A file's text at a commit, or why it could not be read; `undefined` when there is none. */
export type FileAt = { text: string } | { unread: string } | undefined;

/** The lock files a change names by their path, at any depth, never read. */
const LOCK_FILES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lock',
  'bun.lockb',
  'Cargo.lock',
  'go.sum',
  'packages.lock.json',
]);
/** The folders of CI configuration, from the repository's root. */
const CI_FOLDERS = ['.github/workflows/', '.github/actions/', '.circleci/'];
/** The CI files at the repository's root. */
const CI_FILES = new Set(['azure-pipelines.yml', 'Jenkinsfile']);
/** The most changed manifests read at both ends of one change; the rest are counted. */
const MAX_MANIFESTS = 64;
/** How many of each kind the line names. */
const MOST_NAMED = 10;

const isLock = (path: string): boolean => LOCK_FILES.has(fileName(path));
const isCi = (path: string): boolean =>
  CI_FILES.has(path) || CI_FOLDERS.some((folder) => path.startsWith(folder));
const isMigration = (path: string): boolean => inFolderNamed(path, ['migrations']);

/** A dependency's side as one line: its version, its git URL and ref, or its project path. */
const viaText = (via: DependencyVia): string => {
  switch (via.kind) {
    case 'package':
      return mapName(via.version ?? '') || 'any version';
    case 'git':
      return mapName(via.ref === undefined ? via.url : `${via.url}#${via.ref}`) || 'a git URL';
    case 'project':
      return mapName(via.path) || 'a project';
    default: {
      const unknown: never = via;
      throw new Error(`unknown dependency ${JSON.stringify(unknown)}`);
    }
  }
};

type Dependencies = Map<string, string> | { unread: string };

/** The dependencies of the manifest at `path`, from its `file`, by name, or why they cannot be read. */
const dependenciesAt = (reader: ManifestReader, path: string, file: FileAt): Dependencies => {
  const named = new Map<string, string>();
  if (file === undefined) return named;
  if ('unread' in file) return { unread: mapName(file.unread) || 'git could not read it' };
  const read = reader.read(path, file.text);
  if (read.kind === 'unreadable') return { unread: mapName(read.reason) || 'it cannot be read' };
  for (const { name, via } of read.dependsOn) {
    const key = mapName(name);
    if (key === '') continue;
    const text = viaText(via);
    const before = named.get(key);
    named.set(key, before === undefined || before === text ? text : `${before}, ${text}`);
  }
  return named;
};

/** What one manifest's change does to its dependencies, from `since` to `commit`. */
const manifestChanges = async (
  reader: ManifestReader,
  manifest: string,
  since: string,
  commit: string,
  fileAt: (commit: string, path: string) => Promise<FileAt>,
): Promise<DependencyChange[]> => {
  const before = dependenciesAt(reader, manifest, await fileAt(since, manifest));
  const after = dependenciesAt(reader, manifest, await fileAt(commit, manifest));
  // A manifest that cannot be read at one end is named with that end, and nothing else of it.
  if ('unread' in before) return [{ manifest, kind: 'unread', at: since, why: before.unread }];
  if ('unread' in after) return [{ manifest, kind: 'unread', at: commit, why: after.unread }];
  const changes: DependencyChange[] = [];
  for (const [name, to] of after) {
    const from = before.get(name);
    if (from === undefined) changes.push({ manifest, kind: 'added', name, to });
    else if (from !== to) changes.push({ manifest, kind: 'changed', name, from, to });
  }
  for (const [name, from] of before) {
    if (!after.has(name)) changes.push({ manifest, kind: 'removed', name, from });
  }
  return changes;
};

const filesOf = (files: readonly string[]) =>
  files.length === 0 ? undefined : { count: files.length, files: files.slice(0, MAX_SENSITIVE) };

/**
 * What the change's `files`, from `since` to `commit`, holds that a person should look at before
 * merging: the dependencies of each manifest a reader of the system map reads (ADR 0317), compared
 * at both ends; each lock file, CI file and file in a `migrations` folder by its path. Nothing when
 * none of them is there.
 */
export const lookOf = async (
  files: readonly string[],
  since: string,
  commit: string,
  fileAt: (commit: string, path: string) => Promise<FileAt>,
): Promise<LookBeforeMerging | undefined> => {
  const manifests = files.flatMap((path) => {
    const reader = READERS.find((each) => each.matches(path));
    return reader === undefined ? [] : [{ path, reader }];
  });
  const changes: DependencyChange[] = [];
  for (const { path, reader } of manifests.slice(0, MAX_MANIFESTS)) {
    changes.push(...(await manifestChanges(reader, path, since, commit, fileAt)));
  }
  const left = manifests.length - MAX_MANIFESTS;
  const dependencies =
    changes.length === 0
      ? undefined
      : {
          count: changes.length,
          changes: changes.slice(0, MAX_SENSITIVE),
          ...(left > 0 ? { left } : {}),
        };
  const locks = filesOf(files.filter(isLock));
  const ci = filesOf(files.filter(isCi));
  const migrations = filesOf(files.filter(isMigration));
  const look: LookBeforeMerging = {
    ...(dependencies === undefined ? {} : { dependencies }),
    ...(locks === undefined ? {} : { locks }),
    ...(ci === undefined ? {} : { ci }),
    ...(migrations === undefined ? {} : { migrations }),
  };
  return Object.keys(look).length === 0 ? undefined : look;
};

/** `named`, each escaped to one plain line, and a count of the rest of `count`. */
const listed = (named: readonly string[], count: number): string => {
  const shown = named.slice(0, MOST_NAMED);
  if (shown.length === 0) return `${count} more files`;
  const more = count - shown.length;
  return `${shown.join(', ')}${more > 0 ? ` and ${more} more` : ''}`;
};

const changeText = (change: DependencyChange): string => {
  switch (change.kind) {
    case 'added':
      return `new: ${plain(change.name)} ${plain(change.to)}`;
    case 'removed':
      return `removed: ${plain(change.name)} ${plain(change.from)}`;
    case 'changed':
      return `${plain(change.name)} ${plain(change.from)} → ${plain(change.to)}`;
    case 'unread':
      return `not read at ${code(shortSha(change.at))}: ${plain(change.why)}`;
    default:
      return change satisfies never;
  }
};

/** The first `MOST_NAMED` dependency changes, by manifest, and a count of the rest. */
const dependencyText = ({
  count,
  changes,
  left,
}: NonNullable<LookBeforeMerging['dependencies']>): string => {
  const byManifest = new Map<string, string[]>();
  for (const change of changes.slice(0, MOST_NAMED)) {
    byManifest.set(change.manifest, [
      ...(byManifest.get(change.manifest) ?? []),
      changeText(change),
    ]);
  }
  const named = [...byManifest].map(
    ([manifest, texts]) => `${plain(manifest)} (${texts.join(', ')})`,
  );
  const more = count - Math.min(changes.length, MOST_NAMED);
  return [
    named.join(', '),
    ...(more > 0 ? [` and ${more} more`] : []),
    ...(left === undefined ? [] : [`, and ${left} more manifests not read`]),
  ].join('');
};

/**
 * The merge brief's line of what to look at before merging, from what the latest push recorded:
 * each kind with its files, the sensitive paths (ADR 0201) last and without a file another kind
 * already names; nothing when the push recorded none.
 */
export const lookLine = ({
  look,
  sensitive,
}: Pick<PushResult, 'look' | 'sensitive'>): string | undefined => {
  const parts: string[] = [];
  const shown = new Set<string>();
  const files = (label: string, found: { count: number; files: string[] } | undefined) => {
    if (found === undefined) return;
    for (const file of found.files) shown.add(file);
    parts.push(`${label}: ${listed(found.files.map(plain), found.count)}`);
  };
  if (look?.dependencies !== undefined) {
    for (const { manifest } of look.dependencies.changes) shown.add(manifest);
    parts.push(`a dependency changed: ${dependencyText(look.dependencies)}`);
  }
  files('a lock file changed', look?.locks);
  files('a CI file changed', look?.ci);
  files('a migration changed', look?.migrations);
  if (sensitive !== undefined) parts.push(...sensitivePart(sensitive, shown));
  return parts.length === 0 ? undefined : `**Look at before merging:** ${parts.join('; ')}.`;
};

/** The sensitive files no other kind of the line names, and the count of the rest. */
const sensitivePart = (sensitive: SensitiveFiles, shown: ReadonlySet<string>): string[] => {
  const left = sensitive.files.filter((file) => !shown.has(file));
  const count = sensitive.count - (sensitive.files.length - left.length);
  return count === 0 ? [] : [`sensitive paths: ${listed(left.map(plain), count)}`];
};
