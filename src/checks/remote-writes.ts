// The engine's own writes to target repositories' remotes (ADR 0106): each writer notes the ref it
// writes while it writes, so that the noPush guard tells a ref the engine moved during an attempt
// from one its brewer moved.

import type { ClaimHost } from '../engine/issue-claims.ts';
import type { BranchPush } from '../engine/pull-request-actions.ts';

/** The refs of one remote the engine wrote while the window was open. */
export interface RemoteWindow {
  /** Closes the window: the refs written at any time it was open, also by a write begun before. */
  close(): ReadonlySet<string>;
}

export interface RemoteWrites {
  /** Notes that the engine writes `ref` of `repo`'s remote; call the answer once the write ended. */
  writing(repo: string, ref: string): () => void;
  /** Opens a window on `repo`'s remote. */
  watch(repo: string): RemoteWindow;
}

export function remoteWrites(): RemoteWrites {
  throw new Error('not implemented');
}

/** `push`, whose pushes `writes` notes, of `repo`. */
export function notedPush(_push: BranchPush, _writes: RemoteWrites, _repo: string): BranchPush {
  throw new Error('not implemented');
}

/** `claims`, whose creates and deletes of claim refs `writes` notes. */
export function notedClaims(_claims: ClaimHost, _writes: RemoteWrites): ClaimHost {
  throw new Error('not implemented');
}
