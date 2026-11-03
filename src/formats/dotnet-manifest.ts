// .NET's manifests for the system map (ADR 0317): a project file's package id, its package and
// project references, and a solution's projects outside the repository.

import { posix } from 'node:path';
import {
  fileName,
  inBuiltFolder,
  type ManifestDependency,
  type ManifestRead,
  type ManifestReader,
} from './manifest-reader.ts';
import { type Element, elements, NotXml, readXml, textOf } from './xml.ts';

const PROJECT = /\.(?:cs|fs|vb)proj$/i;
const SOLUTION = /\.sln$/i;
// `Project("{type}") = "Name", "path\to\Name.csproj", "{id}"`
const SOLUTION_PROJECT = /^Project\("[^"]*"\)\s*=\s*"[^"]*",\s*"([^"]*)"/;

/** Every element named `name` under `element`, in document order. */
const descendants = (element: Element, name: string): Element[] =>
  elements(element).flatMap((child) =>
    child.name === name ? [child, ...descendants(child, name)] : descendants(child, name),
  );

const stem = (path: string): string => fileName(path.replaceAll('\\', '/')).replace(/\.[^.]*$/, '');

/** A path the manifest at `manifest` names, from the repository's root, with forward slashes. */
const fromRoot = (manifest: string, path: string): string =>
  posix.normalize(posix.join(posix.dirname(manifest), path.replaceAll('\\', '/')));

const firstText = (root: Element, name: string): string | undefined => {
  const text = descendants(root, name)
    .map((element) => textOf(element).trim())
    .find((each) => each !== '');
  return text;
};

const readProject = (path: string, text: string): ManifestRead => {
  let root: Element;
  try {
    root = readXml(text);
  } catch (error) {
    if (error instanceof NotXml) return { kind: 'unreadable', reason: `not XML: ${error.message}` };
    throw error;
  }
  const packable = firstText(root, 'IsPackable')?.toLowerCase() !== 'false';
  const id = firstText(root, 'PackageId') ?? (packable ? stem(path) : undefined);
  const dependsOn: ManifestDependency[] = [];
  for (const reference of descendants(root, 'PackageReference')) {
    const name = reference.attributes.get('Include');
    if (name === undefined) continue;
    const version = reference.attributes.get('Version') ?? firstText(reference, 'Version');
    dependsOn.push({
      name,
      via: { kind: 'package', ...(version === undefined ? {} : { version }) },
    });
  }
  for (const reference of descendants(root, 'ProjectReference')) {
    const include = reference.attributes.get('Include');
    if (include === undefined) continue;
    dependsOn.push({
      name: stem(include),
      via: { kind: 'project', path: fromRoot(path, include) },
    });
  }
  return { kind: 'read', publishes: id === undefined ? [] : [id], dependsOn };
};

/** A solution's projects outside the repository: its own are read from their project files. */
const readSolution = (path: string, text: string): ManifestRead => {
  const dependsOn: ManifestDependency[] = [];
  for (const line of text.split('\n')) {
    const project = SOLUTION_PROJECT.exec(line.trim())?.[1];
    if (project === undefined || !PROJECT.test(project)) continue;
    const resolved = fromRoot(path, project);
    if (resolved.startsWith('../')) {
      dependsOn.push({ name: stem(project), via: { kind: 'project', path: resolved } });
    }
  }
  return { kind: 'read', publishes: [], dependsOn };
};

export const dotnetManifest: ManifestReader = {
  ecosystem: '.NET',
  matches: (path) => (PROJECT.test(path) || SOLUTION.test(path)) && !inBuiltFolder(path),
  read: (path, text) => (SOLUTION.test(path) ? readSolution(path, text) : readProject(path, text)),
};
