// Git in a clone that attempt worktrees share (ADR 0096).

/**
 * The repository's remote as Foedrum names it, reached from git directories of Foedrum's own,
 * never through the clone's configuration (ADR 0090, ADR 0096).
 */
export interface OwnRemote {
  /** `https://github.com/<owner>/<name>.git`: the repository the pull request goes into. */
  url: string;
  /** The folder each call makes its git directory in, and removes it from after. */
  root: string;
  /** The name of each git directory; default a random UUID. */
  id?: () => string;
}
