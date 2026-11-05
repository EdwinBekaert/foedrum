// npm's manifest for the system map (ADR 0317): `package.json`'s name is the package a repository
// publishes, and each dependency field's entries what it depends on, a git URL or a folder included.

import { parseJson } from './json.ts';
import {
  type DependencyVia,
  fileName,
  fromRoot,
  inBuiltFolder,
  type ManifestDependency,
  type ManifestReader,
  withoutBom,
} from './manifest-reader.ts';

const FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const;

// A git dependency: a git URL, a host's shorthand, or GitHub's bare `owner/name`.
const GIT = /^(?:git\+|git:|github:|gitlab:|bitbucket:)/i;
const OWNER_NAME = /^[\w.-]+\/[\w.-]+(?:#.*)?$/;

/**
 * How a dependency's spec in the manifest at `path` names it: a git URL with the ref after its `#`,
 * a folder from the repository's root, with `/` between its folders, or a version.
 */
const viaOf = (path: string, spec: string): DependencyVia => {
  if (GIT.test(spec) || OWNER_NAME.test(spec)) {
    const hash = spec.indexOf('#');
    if (hash < 0) return { kind: 'git', url: spec };
    const ref = spec.slice(hash + 1);
    return { kind: 'git', url: spec.slice(0, hash), ...(ref === '' ? {} : { ref }) };
  }
  if (spec.startsWith('file:')) {
    return { kind: 'project', path: fromRoot(path, spec.slice('file:'.length)) };
  }
  return { kind: 'package', version: spec };
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const npmManifest: ManifestReader = {
  ecosystem: 'npm',
  matches: (path) => fileName(path) === 'package.json' && !inBuiltFolder(path),
  read: (path, text) => {
    const manifest = parseJson(withoutBom(text));
    if (!isObject(manifest)) return { kind: 'unreadable', reason: 'it is not a JSON object' };
    const publishes = typeof manifest.name === 'string' ? [manifest.name] : [];
    const dependsOn: ManifestDependency[] = [];
    for (const field of FIELDS) {
      const entries = manifest[field];
      if (entries === undefined) continue;
      if (!isObject(entries))
        return { kind: 'unreadable', reason: `its ${field} is not an object` };
      for (const [name, spec] of Object.entries(entries)) {
        if (typeof spec === 'string') dependsOn.push({ name, via: viaOf(path, spec) });
      }
    }
    return { kind: 'read', publishes, dependsOn };
  },
};
