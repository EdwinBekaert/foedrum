// The engine's own writes to target repositories' remotes (ADR 0106): each writer notes the ref it
// writes while it writes, so that the noPush guard tells a ref the engine moved during an attempt
// from one its brewer moved.

import type { ClaimHost } from '../engine/issue-claims.ts';
import { claimRef } from '../engine/issue-claims.ts';
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

interface Write {
  repo: string;
  ref: string;
}

interface Window {
  repo: string;
  refs: Set<string>;
}

// GitHub compares repository names without case.
const repoKey = (repo: string): string => repo.toLowerCase();

export function remoteWrites(): RemoteWrites {
  // Only the writes under way and the open windows: nothing grows with time.
  const underway = new Set<Write>();
  const open = new Set<Window>();
  return {
    writing: (repo, ref) => {
      const write = { repo: repoKey(repo), ref };
      underway.add(write);
      for (const window of open) if (window.repo === write.repo) window.refs.add(ref);
      return () => {
        underway.delete(write);
      };
    },
    watch: (repo) => {
      const window: Window = { repo: repoKey(repo), refs: new Set() };
      for (const write of underway) if (write.repo === window.repo) window.refs.add(write.ref);
      open.add(window);
      return {
        close: () => {
          open.delete(window);
          return window.refs;
        },
      };
    },
  };
}

/** Runs `write` while `writes` notes `ref` of `repo`. */
const noting = async <T>(
  writes: RemoteWrites,
  repo: string,
  ref: string,
  write: () => Promise<T>,
): Promise<T> => {
  const done = writes.writing(repo, ref);
  try {
    return await write();
  } finally {
    done();
  }
};

/** `push`, whose pushes `writes` notes, of `repo`. */
export function notedPush(push: BranchPush, writes: RemoteWrites, repo: string): BranchPush {
  return {
    ...push,
    push: (commit, branch, signal) =>
      noting(writes, repo, `refs/heads/${branch}`, () => push.push(commit, branch, signal)),
  };
}

/** `claims`, whose creates and deletes of claim refs `writes` notes. */
export function notedClaims(claims: ClaimHost, writes: RemoteWrites): ClaimHost {
  return {
    ...claims,
    create: (repo, issue, message, signal) =>
      noting(writes, repo, claimRef(issue), () => claims.create(repo, issue, message, signal)),
    delete: (repo, issue, sha, signal) =>
      noting(writes, repo, claimRef(issue), () => claims.delete(repo, issue, sha, signal)),
  };
}
