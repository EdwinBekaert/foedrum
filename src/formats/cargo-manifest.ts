// Cargo's manifest for the system map (ADR 0320): `[package] name` is the crate a repository
// publishes, and each entry of the dependency tables, a target's and the workspace's among them,
// what it depends on, by a git URL with its ref, a folder or a version. A workspace's members are
// each a `Cargo.toml` of their own, read as any other.

import { posix } from 'node:path';
import {
  type DependencyVia,
  fileName,
  fromRoot,
  inFolderNamed,
  type ManifestDependency,
  type ManifestRead,
  type ManifestReader,
} from './manifest-reader.ts';
import { NotToml, readToml, type TomlEntry, type TomlValue } from './toml.ts';

const TABLES: ReadonlySet<string> = new Set([
  'dependencies',
  'dev-dependencies',
  'build-dependencies',
  // Cargo still takes these older spellings, as it does `[project]` for `[package]`.
  'dev_dependencies',
  'build_dependencies',
]);

// The keys of a dependency in Cargo's schema that the map reads, each a string,
const SOURCE_KEYS: ReadonlySet<string> = new Set([
  'version',
  'git',
  'tag',
  'rev',
  'branch',
  'path',
  'package',
]);
// and those it has no use for. A key of neither makes the manifest unreadable (ADR 0320).
const OTHER_KEYS: ReadonlySet<string> = new Set([
  'artifact',
  'base',
  'builtin',
  'default-features',
  'default_features',
  'features',
  'lib',
  'optional',
  'public',
  'registry',
  'registry-index',
  'target',
  'workspace',
]);

/** How many of `path`'s parts name a dependency table, or 0 when it lies in none. */
const tableLength = (path: readonly string[]): number => {
  if (TABLES.has(path[0] ?? '')) return 1;
  if (path[0] === 'workspace' && path[1] === 'dependencies') return 2;
  if (path[0] === 'target' && TABLES.has(path[2] ?? '')) return 3;
  return 0;
};

class Refused extends Error {}

interface Spec {
  name: string;
  version?: string;
  keys: Map<string, string>;
  inherited: boolean;
}

/** Adds what one statement says of the dependency in `spec`. */
const addTo = (spec: Spec, rest: readonly string[], value: TomlValue): void => {
  const [key = ''] = rest;
  if (rest.length === 0) {
    if (value.kind === 'string') spec.version = value.text;
    else if (value.kind !== 'table') {
      throw new Refused(`its dependency ${spec.name} is neither a version nor a table`);
    }
  } else if (rest.length === 1 && SOURCE_KEYS.has(key)) {
    if (value.kind !== 'string') {
      throw new Refused(`its dependency ${spec.name} has a ${key} that is not a string`);
    }
    spec.keys.set(key, value.text);
  } else if (rest.length === 1 && OTHER_KEYS.has(key)) {
    if (key === 'workspace') spec.inherited = true;
  } else {
    throw new Refused(
      `its dependency ${spec.name} has the key ${rest.join('.')}, which Cargo's schema does not name`,
    );
  }
};

/** A dependency as its source names it: a git URL before a folder before a version. */
const viaOf = (manifest: string, { keys, version }: Spec): DependencyVia => {
  const url = keys.get('git');
  if (url !== undefined) {
    const ref = keys.get('tag') ?? keys.get('rev') ?? keys.get('branch');
    return { kind: 'git', url, ...(ref === undefined ? {} : { ref }) };
  }
  const folder = keys.get('path');
  if (folder !== undefined) return { kind: 'project', path: fromRoot(manifest, folder) };
  const given = keys.get('version') ?? version;
  return { kind: 'package', ...(given === undefined ? {} : { version: given }) };
};

const readManifest = (manifest: string, entries: readonly TomlEntry[]): ManifestRead => {
  const publishes: string[] = [];
  const specs = new Map<string, Spec>();
  for (const { path, value } of entries) {
    if (
      path.length === 2 &&
      (path[0] === 'package' || path[0] === 'project') &&
      path[1] === 'name'
    ) {
      if (value.kind !== 'string') throw new Refused('its package name is not a string');
      publishes.push(value.text);
    }
    const length = tableLength(path);
    if (length === 0 || path.length <= length) continue;
    const name = path[length] ?? '';
    const at = JSON.stringify(path.slice(0, length + 1));
    const spec = specs.get(at) ?? { name, keys: new Map(), inherited: false };
    specs.set(at, spec);
    addTo(spec, path.slice(length + 1), value);
  }
  const seen = new Set<string>();
  const dependsOn: ManifestDependency[] = [];
  for (const spec of specs.values()) {
    // A member's `workspace = true` names no source: the workspace's own entry gives the link.
    if (spec.inherited) continue;
    const dependency = { name: spec.keys.get('package') ?? spec.name, via: viaOf(manifest, spec) };
    const key = JSON.stringify(dependency);
    if (!seen.has(key)) dependsOn.push(dependency);
    seen.add(key);
  }
  return { kind: 'read', publishes, dependsOn };
};

export const cargoManifest: ManifestReader = {
  ecosystem: 'Cargo',
  // Cargo writes no manifest directly in a `target` folder, so a crate of that name is read.
  matches: (path) =>
    fileName(path) === 'Cargo.toml' &&
    !inFolderNamed(path, ['node_modules', 'vendor']) &&
    !inFolderNamed(posix.dirname(path), ['target']),
  read: (path, text) => {
    try {
      return readManifest(path, readToml(text));
    } catch (error) {
      if (error instanceof NotToml) {
        return { kind: 'unreadable', reason: `not TOML: ${error.message}` };
      }
      if (error instanceof Refused) return { kind: 'unreadable', reason: error.message };
      throw error;
    }
  },
};
