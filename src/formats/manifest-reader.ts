// A reader of one ecosystem's manifests for the system map (ADR 0317): which paths it reads, and
// what a manifest's text says the repository publishes and depends on. Repository content, so
// untrusted input (ADR 0041). Pure; a reader of another ecosystem is one more file of this shape.

import { posix } from 'node:path';
import type { MapDependencyVia } from '../schemas/system-map.ts';
import type { z } from '../schemas/zod.ts';

/**
 * How a manifest names a dependency: by a package and its version, a git URL, or a project path
 * from the repository's root; the schema's shape, before the map cuts its values.
 */
export type DependencyVia = z.input<typeof MapDependencyVia>;

export interface ManifestDependency {
  name: string;
  via: DependencyVia;
}

/** What a manifest says, or why it could not be read: never nothing. */
export type ManifestRead =
  | { kind: 'read'; publishes: string[]; dependsOn: ManifestDependency[] }
  | { kind: 'unreadable'; reason: string };

export interface ManifestReader {
  /** The ecosystem's name, as the map shows it: `npm`, `.NET`. */
  ecosystem: string;
  /** Whether the reader reads the file at `path`, relative to the repository's root. */
  matches: (path: string) => boolean;
  read: (path: string, text: string) => ManifestRead;
}

/** The last segment of a path in git's form, with forward slashes. */
export const fileName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/** A path the manifest at `manifest` names, from the repository's root, with forward slashes. */
export const fromRoot = (manifest: string, path: string): string =>
  posix.normalize(posix.join(posix.dirname(manifest), path.replaceAll('\\', '/')));

/** Whether `path` lies in a folder of one of `names`, lower case, at any depth. */
export const inFolderNamed = (path: string, names: readonly string[]): boolean =>
  path
    .split('/')
    .slice(0, -1)
    .some((folder) => names.includes(folder.toLowerCase()));

/** Whether `path` lies in a folder of installed or built files, whose manifests are not the repository's. */
export const inBuiltFolder = (path: string): boolean =>
  inFolderNamed(path, ['node_modules', 'bin', 'obj']);
