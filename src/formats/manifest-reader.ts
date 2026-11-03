// A reader of one ecosystem's manifests for the system map (ADR 0317): which paths it reads, and
// what a manifest's text says the repository publishes and depends on. Repository content, so
// untrusted input (ADR 0041). Pure; a reader of another ecosystem is one more file of this shape.

/** How a manifest names a dependency: by a package and its version, a git URL, or a project path. */
export type DependencyVia =
  | { kind: 'package'; version?: string }
  | { kind: 'git'; url: string; ref?: string }
  | { kind: 'project'; path: string };

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

/** Whether `path` lies in a folder of installed or built files, whose manifests are not the repository's. */
export const inBuiltFolder = (path: string): boolean =>
  path
    .split('/')
    .slice(0, -1)
    .some((folder) => ['node_modules', 'bin', 'obj'].includes(folder.toLowerCase()));
