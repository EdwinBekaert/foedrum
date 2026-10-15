// How a worktree is removed, from the state of its folder and its record (ADR 0021): the rule the
// worktree cleanup and the attempt worktree manager share. worktree-removal-git.ts carries it out.

// clean or dirty: the folder is a worktree; no-git: the folder is there without its .git
// file; gone: only the record under .git/worktrees/ is left; unchecked: never looked at.
export type FolderState = 'clean' | 'dirty' | 'no-git' | 'gone' | 'unchecked';

export type Removal =
  // git worktree remove, then whatever a busy file left behind.
  | { kind: 'remove'; path: string; record: string | undefined }
  // A removal that stopped after deleting the .git file: the folder and the record go.
  | { kind: 'finish'; path: string; record: string }
  // Only the record is left.
  | { kind: 'prune'; record: string };

export type RemovalOrKeep = Removal | { kind: 'keep'; reason: string };

/** Why a worktree with changes stays; undefined for any other folder. */
export const dirtyReason = (state: FolderState): string | undefined =>
  state === 'dirty' ? 'it has uncommitted or untracked changes' : undefined;

/** How to remove a worktree that nothing else keeps, or why it cannot be removed. */
export const removalOf = (worktree: {
  path: string;
  record: string | undefined;
  state: FolderState;
}): RemovalOrKeep => {
  const { path, record, state } = worktree;
  const dirty = dirtyReason(state);
  if (dirty !== undefined) return { kind: 'keep', reason: dirty };
  if (state === 'gone' && record !== undefined) return { kind: 'prune', record };
  if (state === 'no-git' && record !== undefined) return { kind: 'finish', path, record };
  if (state === 'clean') return { kind: 'remove', path, record };
  return { kind: 'keep', reason: 'no record under .git/worktrees/ points at it' };
};
