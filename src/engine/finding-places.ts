// Whether the place each Taster finding cites exists at the head the Taster reviewed (ADR 0421):
// a file, and a line within it, by the citation check /brew-review runs too. Git runs only through
// the injected `ReadFiles`, so no model and no fold is involved.

import { checkLine, isObject, isPlainPath } from '../checks/citations.ts';
import { type TastingFinding, tastingOf } from '../schemas/out-doc.ts';
import { z } from '../schemas/zod.ts';
import type { Ending } from './decide.ts';

/** The tree a Taster reviewed: the commit its worktree started at, in its repository's clone. */
export interface ReviewedTree {
  clone: string;
  commit: string;
}

/**
 * The text of each of the paths that is a regular file at the commit, and none for one that is not
 * (missing, a folder, a link or a submodule); or why git could not read them.
 */
export type FilesRead =
  | { kind: 'read'; files: ReadonlyMap<string, string | undefined> }
  | { kind: 'unread'; reason: string };

/** The files `paths` at `commit` in `clone`; never throws, git's failure is `unread`. */
export type ReadFiles = (
  clone: string,
  commit: string,
  paths: readonly string[],
  signal?: AbortSignal,
) => Promise<FilesRead>;

/** The finding marked where its file, or its line, is not in `files`; one with no file as it is. */
const checked = (
  finding: TastingFinding,
  files: ReadonlyMap<string, string | undefined>,
): TastingFinding => {
  const { file, line } = finding;
  if (file === undefined) return finding;
  const content = isPlainPath(file) ? files.get(file) : undefined;
  if (content === undefined) return { ...finding, missing: 'file' };
  if (line === undefined || checkLine({ file, line }, content).ok) return finding;
  return { ...finding, missing: 'line' };
};

/**
 * `ending`, with each finding of a Taster's marked where its file or its line does not exist in
 * `reviewed` (ADR 0421): a succeeded Taster's, or one blocked by its findings. Nothing is marked
 * when git cannot read the files, and no finding is dropped; any other ending as it is.
 */
export async function placesChecked(
  read: ReadFiles,
  ending: Ending,
  reviewed: ReviewedTree | undefined,
  signal?: AbortSignal,
): Promise<Ending> {
  if (reviewed === undefined) return ending;
  const findings =
    ending.kind === 'blocked'
      ? ending.findings
      : ending.kind === 'succeeded'
        ? tastingOf(ending.output)?.findings
        : undefined;
  const cited = (findings ?? []).flatMap(({ file }) =>
    file !== undefined && isPlainPath(file) ? [file] : [],
  );
  if (findings === undefined || findings.every(({ file }) => file === undefined)) return ending;
  // A finding whose path is no plain path is marked without a read: no tree holds it.
  const files: FilesRead =
    cited.length === 0
      ? { kind: 'read', files: new Map() }
      : await read(reviewed.clone, reviewed.commit, [...new Set(cited)], signal);
  if (files.kind === 'unread') return ending;
  const marked = findings.map((finding) => checked(finding, files.files));
  if (ending.kind === 'blocked') return { ...ending, findings: marked };
  if (ending.kind !== 'succeeded' || !isObject(ending.output)) return ending;
  return { ...ending, output: z.json().parse({ ...ending.output, findings: marked }) };
}
