// Decides where an attempt's worktree lives, whether it can be created or recreated, and what a
// cleanup removes (ADR 0012, ADR 0029). Pure: attempt-worktrees-git.ts gathers the facts from git
// and carries the decisions out (ADR 0021).

import { join } from 'node:path';
import { Repo } from '../schemas/events.ts';
import { PathSafeId } from '../schemas/ids.ts';
import {
  type FolderState,
  type Removal,
  type RemovalOrKeep,
  removalOf,
} from './worktree-removal.ts';

/** One attempt of a step of a batch; the same shape as the engine's `AttemptRef`. */
export interface AttemptRef {
  batchId: string;
  stepId: string;
  attempt: number;
}

/** The folder of a repository under the work root: `<owner>.<name>`, lower case. */
export const repoFolder = (repo: string): string => {
  // The owner has no dot, so the first one separates the two.
  const folder = repo.toLowerCase().replace('/', '.');
  if (!Repo.safeParse(repo).success || !PathSafeId.safeParse(folder).success) {
    throw new Error(
      `The repository ${JSON.stringify(repo)} has no folder in the work root: <owner>.<name> in lower case must be one path segment of at most 64 characters`,
    );
  }
  return folder;
};

/** Where the managed clone of `repo` is in the work root (ADR 0012). */
export const managedClonePath = (workRoot: string, repo: string): string =>
  join(workRoot, repoFolder(repo), 'clone.git');

/**
 * Where each push, fetch and ls-remote of `repo` makes a git directory of its own, which writes into
 * its clone's objects and reads none of the clone's configuration (ADR 0090, ADR 0096).
 */
export const ownGitDirsRoot = (workRoot: string, repo: string): string =>
  join(workRoot, repoFolder(repo), 'git-dirs');

/** An entry of the git directories' root. */
export interface OwnGitDirEntry {
  name: string;
  /** Whether it is a directory, not a file or a link. */
  directory: boolean;
  /** When it last changed, in ms since the epoch: never before it was made. */
  modifiedMs: number;
}

/**
 * The git directories a stopped call left that a cleanup removes (ADR 0130): `<uuid>.git`
 * directories older than the floor. Anything else in the root stays.
 */
export const planOwnGitDirs = (_entries: readonly OwnGitDirEntry[], _now: number): string[] => {
  throw new Error('not implemented');
};

// A path segment that is also a component of a branch name: git refuses `..` anywhere and a
// `.lock` ending (git check-ref-format).
const refSegment = (id: string): boolean =>
  PathSafeId.safeParse(id).success && !id.includes('..') && !id.endsWith('.lock');

const isAttempt = ({ batchId, stepId, attempt }: AttemptRef): boolean =>
  // foedrum/state is the state branch, so no branch can be below it.
  refSegment(batchId) &&
  batchId !== 'state' &&
  refSegment(stepId) &&
  Number.isSafeInteger(attempt) &&
  attempt > 0;

const checked = (ref: AttemptRef): AttemptRef => {
  if (!isAttempt(ref)) {
    const parts = JSON.stringify([ref.batchId, ref.stepId, ref.attempt]);
    throw new Error(
      `Invalid attempt ${parts}: its ids must be path segments and branch name parts`,
    );
  }
  return ref;
};

// The attempt of three name parts, when they are its canonical spelling.
const attemptOf = (parts: string[]): AttemptRef | undefined => {
  const [batchId = '', stepId = '', number = ''] = parts;
  const ref = { batchId, stepId, attempt: Number(number) };
  return parts.length === 3 && isAttempt(ref) && String(ref.attempt) === number ? ref : undefined;
};

/** The local branch of an attempt: `foedrum/<batchId>/<stepId>/<attempt>`. */
export const attemptBranch = (ref: AttemptRef): string => {
  const { batchId, stepId, attempt } = checked(ref);
  return `foedrum/${batchId}/${stepId}/${attempt}`;
};

/**
 * The name the local branch `foedrum/<rest>` is pushed under in a target repository:
 * `foedrum/<brewery>/<rest>`, with the Brewery as `<owner>.<name>` in lower case, so two Breweries
 * never push the same branch (ADR 0043).
 */
export const remoteBranch = (brewery: string, local: string): string => {
  const [namespace, ...rest] = local.split('/');
  if (namespace !== 'foedrum' || rest.length === 0 || rest.includes('')) {
    throw new Error(`${JSON.stringify(local)} is not a branch in foedrum/`);
  }
  const prefix = repoFolder(brewery);
  if (!refSegment(prefix)) {
    throw new Error(`The Brewery ${JSON.stringify(brewery)} is no part of a branch name`);
  }
  return `foedrum/${prefix}/${rest.join('/')}`;
};

/** The attempt whose branch this is, or undefined for any other branch. */
export const parseAttemptBranch = (name: string): AttemptRef | undefined => {
  const [namespace, ...parts] = name.split('/');
  return namespace === 'foedrum' ? attemptOf(parts) : undefined;
};

// The batch of a branch in a batch's namespace, `foedrum/<batchId>/…`, attempt or not.
const batchOfBranch = (name: string): string | undefined => {
  const [namespace, batchId = '', ...rest] = name.split('/');
  const isBatch = namespace === 'foedrum' && rest.length > 0 && refSegment(batchId);
  return isBatch && batchId !== 'state' ? batchId : undefined;
};

/** The folder of an attempt below the attempts root, with `/` separators. */
export const attemptFolder = (ref: AttemptRef): string => {
  const { batchId, stepId, attempt } = checked(ref);
  return `${batchId}/${stepId}/${attempt}`;
};

/** The attempt whose folder this is (below the attempts root, `/` separators), or undefined. */
export const parseAttemptFolder = (inside: string): AttemptRef | undefined =>
  attemptOf(inside.split('/'));

/** A worktree git lists for the clone. */
export interface ListedFact {
  path: string;
  /** The path below the attempts root with `/` separators, or undefined outside it. */
  inside: string | undefined;
  branch: string | undefined;
  lockReason: string | undefined;
  /** `unchecked` outside the attempts root. */
  state: FolderState;
  record: string | undefined;
  /** A clean worktree's untracked out doc, its only change: deleted before it (ADR 0081). */
  outDoc?: string;
}

/** A local branch under `refs/heads/foedrum/`. */
export interface BranchFact {
  name: string;
  tip: string;
}

/** A batch folder under the attempts root and the attempt folders found below it. */
export interface BatchFolderFact {
  batchId: string;
  /** `<stepId>/<attempt>` of every folder two levels below the batch folder. */
  attempts: string[];
  /** The entries of `attempts` that hold a `.git` file or folder. */
  withGit?: string[];
}

export interface Facts {
  worktrees: ListedFact[];
  branches: BranchFact[];
  folders: BatchFolderFact[];
}

/**
 * What the engine's state says about the worktrees: whether each batch it knows is still live
 * (it may brew again: ordered, brewing, conditioning or Stuck) or has ended (on tap or
 * cancelled), and which attempts hold a live lease: the leased attempt and every attempt whose
 * session it continues, whose worktree it runs in (ADR 0029).
 */
export interface Claims {
  batches: ReadonlyMap<string, 'live' | 'ended'>;
  leased: readonly AttemptRef[];
  /**
   * The out doc of each step of an ended batch whose brewer is known, by `<batchId>/<stepId>`:
   * the one untracked file a worktree of that step may have and still go (ADR 0081).
   */
  outDocs?: ReadonlyMap<string, string>;
  /**
   * The branch of each ended batch's task tree that no push recorded (for a rewind, the attempt
   * branches that may hold its commit, ADR 0101), by name, with the commit the batch started from: the only ref
   * to its commits, kept while it holds any (ADR 0084).
   */
  unpushed?: ReadonlyMap<string, string>;
}

/**
 * Whether a worktree is clean, from its `git status --porcelain`: nothing, or nothing but its
 * untracked out doc, which is then named (ADR 0081).
 */
export const worktreeStatus = (
  porcelain: string,
  outDoc: string | undefined,
): { state: 'clean' | 'dirty'; outDoc?: string } => {
  const changes = porcelain.split(/\r?\n/).filter((line) => line !== '');
  if (changes.length === 0) return { state: 'clean' };
  // The out doc is one path segment (`PathSafeId`), so git names it as it is, unquoted.
  const onlyOutDoc = outDoc !== undefined && changes.length === 1 && changes[0] === `?? ${outDoc}`;
  return onlyOutDoc ? { state: 'clean', outDoc } : { state: 'dirty' };
};

export type Action =
  /** `branch` is deleted once the worktree is gone. */
  | (Removal & { label: string; branch: BranchFact | undefined })
  /** A folder under the attempts root that git does not know as a worktree. */
  | { kind: 'remove-folder'; label: string; path: string }
  /** A batch folder whose attempts all went; removed only when it is empty by then. */
  | { kind: 'remove-batch-folder'; label: string; path: string }
  /** Deleted only while it still points at `tip`. */
  | { kind: 'delete-branch'; branch: string; tip: string }
  /** A kept worktree no attempt runs in: its stale index.lock goes. */
  | { kind: 'index-lock'; label: string; gitDir: string };

export interface Plan {
  actions: Action[];
  kept: string[];
}

const LEASED = 'its attempt holds a live lease';

/**
 * What a cleanup removes, from the facts of one clone and the claims. With `batchId`, only that
 * batch's worktrees, folders and branches are looked at (the batch has ended).
 */
export const planClean = (
  facts: Facts,
  claims: Claims,
  root: string,
  scope: { batchId?: string } = {},
): Plan => {
  const actions: Action[] = [];
  const kept: string[] = [];
  const inScope = (batchId: string): boolean =>
    scope.batchId === undefined || scope.batchId === batchId;
  // A worktree with a live lease is never removed (#37: the driver renews the lease, so it
  // expires when the driver dies, even while an orphaned brewer process still runs).
  const leased = (ref: AttemptRef): boolean =>
    claims.leased.some(
      (other) =>
        other.batchId === ref.batchId &&
        other.stepId === ref.stepId &&
        other.attempt === ref.attempt,
    );
  // A batch the state does not know has no claim on the attempts root, which is Foedrum's.
  const live = (batchId: string): boolean => claims.batches.get(batchId) === 'live';
  const tips = new Map(facts.branches.map((branch) => [branch.name, branch]));
  // The task tree of an ended batch that no push recorded: its branch is the only ref to its
  // commits while it holds any past the batch's start (ADR 0084).
  const holdsTaskTree = (name: string | undefined): boolean => {
    if (name === undefined) return false;
    const start = claims.unpushed?.get(name);
    return start !== undefined && tips.get(name)?.tip !== start;
  };
  const inRoot = facts.worktrees.filter(
    (worktree): worktree is ListedFact & { inside: string } => worktree.inside !== undefined,
  );
  // What goes: attempt folders (below the root) and branches that go with their worktree.
  const removed = new Set<string>();
  const branchesDone = new Set<string>();
  // A worktree git lists below the folder: removing the folder would take it along.
  const nestedIn = (inside: string) =>
    inRoot.find((other) => other.state !== 'gone' && other.inside.startsWith(`${inside}/`));

  for (const worktree of inRoot) {
    const { inside, record, state } = worktree;
    const [batchId = ''] = inside.split('/');
    if (!inScope(batchId)) continue;
    // Its branch goes with it, or stays with it.
    if (worktree.branch !== undefined) branchesDone.add(worktree.branch);
    const ref = parseAttemptFolder(inside);
    if (ref === undefined) {
      // A record whose folder is gone holds nothing, wherever it was in the attempts root.
      if (
        state === 'gone' &&
        record !== undefined &&
        !live(batchId) &&
        worktree.lockReason === undefined
      ) {
        actions.push({ kind: 'prune', record, label: inside, branch: undefined });
        removed.add(inside);
      } else if (worktree.lockReason !== undefined && !live(batchId)) {
        kept.push(`kept worktree ${inside}: locked: ${worktree.lockReason || 'no reason given'}`);
      } else kept.push(`kept worktree ${inside}: not an attempt folder`);
      continue;
    }
    const isLeased = leased(ref);
    const nested = nestedIn(inside);
    // undefined: kept without a word, as every worktree of a live batch is.
    let removal: RemovalOrKeep | undefined;
    if (live(batchId)) removal = undefined;
    else if (isLeased) removal = { kind: 'keep', reason: LEASED };
    else if (nested !== undefined) {
      removal = { kind: 'keep', reason: `it contains the worktree ${nested.inside}` };
    } else if (worktree.lockReason !== undefined) {
      removal = { kind: 'keep', reason: `locked: ${worktree.lockReason || 'no reason given'}` };
    } else removal = removalOf(worktree);

    if (removal !== undefined && removal.kind !== 'keep') {
      // The branch goes too only when its batch has ended. A batch the state does not know may
      // have committed work nobody pushed (a store rebuilt without its last events, two
      // Breweries on one work root): its branch stays for the branch pass to report, as does
      // an unpushed task tree's.
      const goes = claims.batches.has(batchId) && !holdsTaskTree(worktree.branch);
      if (!goes && worktree.branch !== undefined) branchesDone.delete(worktree.branch);
      const branch = worktree.branch === undefined || !goes ? undefined : tips.get(worktree.branch);
      const outDoc =
        removal.kind === 'remove' && worktree.outDoc !== undefined
          ? { outDoc: worktree.outDoc }
          : {};
      actions.push({ ...removal, ...outDoc, label: inside, branch });
      removed.add(inside);
      continue;
    }
    if (removal !== undefined) kept.push(`kept worktree ${inside}: ${removal.reason}`);
    if (!isLeased && record !== undefined && (state === 'clean' || state === 'dirty')) {
      actions.push({ kind: 'index-lock', label: inside, gitDir: record });
    }
  }

  // Folders git does not know as worktrees: a crash before git recorded one, or after it
  // dropped the record.
  const batchFolders: Action[] = [];
  for (const { batchId, attempts, withGit = [] } of facts.folders) {
    if (!inScope(batchId)) continue;
    for (const entry of attempts) {
      const inside = `${batchId}/${entry}`;
      if (inRoot.some((worktree) => worktree.inside === inside)) continue;
      const ref = parseAttemptFolder(inside);
      const nested = nestedIn(inside);
      if (ref === undefined) kept.push(`kept folder ${inside}: not an attempt folder`);
      else if (live(batchId)) continue;
      else if (leased(ref)) kept.push(`kept folder ${inside}: ${LEASED}`);
      // git lists it under another spelling of its path, or it belongs to another clone:
      // either way removing it would skip the checks a worktree gets.
      else if (withGit.includes(entry)) {
        kept.push(
          `kept folder ${inside}: it has a .git file, but git does not list it as a worktree of this clone`,
        );
      } else if (nested !== undefined) {
        kept.push(`kept folder ${inside}: it contains the worktree ${nested.inside}`);
      } else {
        const path = join(root, ...inside.split('/'));
        actions.push({ kind: 'remove-folder', label: inside, path });
        removed.add(inside);
      }
    }
    const emptied = attempts.every((entry) => removed.has(`${batchId}/${entry}`));
    if (!live(batchId) && emptied) {
      const path = join(root, batchId);
      batchFolders.push({ kind: 'remove-batch-folder', label: batchId, path });
    }
  }
  actions.push(...batchFolders);

  // Branches that no worktree in the attempts root has: the ones of ended batches go, unless
  // a worktree elsewhere has one checked out. A batch the state does not know may be another
  // Brewery's that shares the clone, so its branches stay.
  const checkedOut = new Map(
    facts.worktrees
      .filter((worktree) => worktree.inside === undefined)
      .map((worktree) => [worktree.branch, worktree.path]),
  );
  for (const branch of facts.branches) {
    const batchId = batchOfBranch(branch.name);
    if (batchId === undefined || !inScope(batchId) || branchesDone.has(branch.name)) continue;
    if (live(batchId)) continue;
    const ref = parseAttemptBranch(branch.name);
    const at = checkedOut.get(branch.name);
    const reason =
      ref !== undefined && leased(ref)
        ? LEASED
        : !claims.batches.has(batchId)
          ? `no batch ${batchId} in this Brewery`
          : holdsTaskTree(branch.name)
            ? `it holds the task tree of batch ${batchId}, which no push recorded (ADR 0084)`
            : at === undefined
              ? undefined
              : `checked out in ${at}`;
    if (reason === undefined) {
      actions.push({ kind: 'delete-branch', branch: branch.name, tip: branch.tip });
    } else kept.push(`kept branch ${branch.name}: ${reason}`);
  }
  return { actions, kept };
};

/** What an attempt's worktree is to start from. */
export type Target =
  /** A new attempt, at the base commit. */
  | { kind: 'new'; base: string }
  /** A resumed attempt, at its recorded commit when its branch is gone (ADR 0019). */
  | { kind: 'resume'; commit: string };

/** The facts about one attempt's folder and branch. */
export interface AttemptFacts {
  /** The worktree git lists at the attempt's folder. */
  listed: ListedFact | undefined;
  /** Whether anything is on disk at the attempt's folder. */
  folderExists: boolean;
  /** The attempt branch's commit, when the branch exists. */
  branchTip: string | undefined;
  /** Where another worktree has the attempt's branch checked out. */
  checkedOutAt: string | undefined;
}

export type WorktreePlan =
  /** The worktree is there already. */
  | { kind: 'reuse' }
  /** `git worktree add`, after pruning a stale record; `newBranch` creates the branch at `at`. */
  | { kind: 'add'; prune: string | undefined; newBranch: boolean; at: string }
  | { kind: 'refuse'; reason: string };

/** How an attempt gets its worktree. */
export const planWorktree = (
  ref: AttemptRef,
  facts: AttemptFacts,
  target: Target,
): WorktreePlan => {
  const branch = attemptBranch(ref);
  const label = attemptFolder(ref);
  const { listed, folderExists, branchTip, checkedOutAt } = facts;
  const refuse = (reason: string): WorktreePlan => ({ kind: 'refuse', reason });
  if (listed !== undefined && listed.state !== 'gone') {
    if (listed.state !== 'clean' && listed.state !== 'dirty') {
      return refuse(`the worktree ${label} cannot be used as it is (${listed.state})`);
    }
    if (listed.branch !== branch) {
      return refuse(`the worktree ${label} is on ${listed.branch ?? 'no branch'}, not ${branch}`);
    }
    // A resumed attempt goes on where it was; a new one only from a worktree nothing touched,
    // which a start that crashed before the brewer ran leaves.
    if (target.kind === 'resume') return { kind: 'reuse' };
    if (listed.state === 'clean' && branchTip === target.base) return { kind: 'reuse' };
    return refuse(`the worktree ${label} is there already, with changes or at another commit`);
  }
  if (folderExists) return refuse(`${label} is a folder git does not know as a worktree`);
  const prune = listed?.record;
  if (branchTip !== undefined) {
    if (checkedOutAt !== undefined) {
      return refuse(`the branch ${branch} is checked out in ${checkedOutAt}`);
    }
    // A branch at the base holds no work; one elsewhere may hold someone else's.
    if (target.kind === 'new' && branchTip !== target.base) {
      return refuse(`the branch ${branch} exists, at another commit than the base`);
    }
    return { kind: 'add', prune, newBranch: false, at: branch };
  }
  const at = target.kind === 'new' ? target.base : target.commit;
  return { kind: 'add', prune, newBranch: true, at };
};
