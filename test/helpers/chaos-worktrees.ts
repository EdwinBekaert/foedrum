// An in-memory clone for the chaos harness (#144, ADR 0037): git's worktree records, the folders
// in the attempts root and the attempt branches, which outlive every driver process as a disk
// does. Its manager decides as the real one does, through `planWorktree` and `planClean`, and
// carries the plans out one git step at a time, with a kill point between the steps. No git runs
// and no folder is made (ADR 0021).

import { join } from 'node:path';
import { type AttemptRef, attemptKey } from '../../src/engine/attempt-key.ts';
import type { Batch, State } from '../../src/engine/fold.ts';
import {
  type Action,
  attemptBranch,
  attemptFolder,
  type BatchFolderFact,
  type Facts,
  type ListedFact,
  parseAttemptBranch,
  parseAttemptFolder,
  planClean,
  planWorktree,
} from '../../src/workspace/attempt-worktrees.ts';
import type {
  AttemptWorktree,
  AttemptWorktrees,
  CleanReport,
} from '../../src/workspace/attempt-worktrees-git.ts';
import type { FolderState } from '../../src/workspace/worktree-removal.ts';
import type { Life } from './chaos.ts';

export const worktreeKillPoints = [
  'while making a worktree',
  'after a worktree was made',
  'while cleaning worktrees',
] as const;
export type WorktreeKillPoint = (typeof worktreeKillPoints)[number];

/** The repository the attempts write in, and the commit `origin/main` is at. */
export const chaosRepo = 'acme/app';
export const chaosBase = 'b'.repeat(40);

const root = join('work', 'acme.app', 'attempts');
const pathOf = (inside: string): string => join(root, ...inside.split('/'));
const recordOf = (inside: string): string =>
  join('clone', '.git', 'worktrees', inside.replaceAll('/', '-'));

/**
 * Whether `batch` has ended: on tap or cancelled. The checks' own rule, not `laneStatus`, so a
 * defect there cannot change what they check.
 */
export const hasEnded = (batch: Batch): boolean =>
  batch.lane.kind === 'on_tap' || batch.lane.kind === 'cancelled';

/** A batch's part of the clone: what of it is still there. */
export interface Leftovers {
  records: string[];
  folders: string[];
  branches: string[];
}

export interface CloneWatch {
  /** Whether a live driver's runner runs this attempt now. */
  running(key: string): boolean;
  /** The folded state of every committed event, as a process beside the drivers sees it. */
  state(): State;
}

/** How the manager's `create` went, for the goals of the worktree cases. */
export type Made = 'added' | 'reused' | 'refused';

export const fakeClone = (watch: CloneWatch) => {
  // inside → the branch it has checked out: git's records under .git/worktrees/.
  const records = new Map<string, string>();
  // The attempt folders on disk, below the attempts root; each has its .git file.
  const folders = new Set<string>();
  const branches = new Map<string, string>();
  /** What was broken: an attempt without its worktree, a removal of something still claimed. */
  const violations: string[] = [];
  const made: { key: string; how: Made }[] = [];
  /** What each clean removed, by batch. */
  const cleaned: { batchId: string | undefined; done: string[]; kept: string[] }[] = [];

  const stateOf = (inside: string): FolderState => (folders.has(inside) ? 'clean' : 'gone');
  const listed = (): ListedFact[] => [
    // The clone's own checkout, outside the attempts root.
    {
      path: 'clone',
      inside: undefined,
      branch: 'main',
      lockReason: undefined,
      state: 'unchecked',
      record: undefined,
    },
    ...[...records].map(([inside, branch]) => ({
      path: pathOf(inside),
      inside,
      branch,
      lockReason: undefined,
      state: stateOf(inside),
      record: recordOf(inside),
    })),
  ];

  /** Notes a removal that breaks a claim: of a running attempt, or of a live batch. */
  const removing = (what: string, batchId: string, ref: AttemptRef | undefined): void => {
    const batch = watch.state().batches.get(batchId);
    if (batch !== undefined && !hasEnded(batch)) {
      violations.push(`removed ${what} of the live batch ${batchId}`);
    }
    if (ref !== undefined && watch.running(attemptKey.encode(ref))) {
      violations.push(`removed ${what} while its attempt ran`);
    }
  };
  const batchOfFolder = (inside: string): string => inside.split('/')[0] ?? '';
  const removeFolder = (inside: string): void => {
    removing(`the folder ${inside}`, batchOfFolder(inside), parseAttemptFolder(inside));
    folders.delete(inside);
  };
  const removeRecord = (inside: string): void => {
    removing(`the worktree record ${inside}`, batchOfFolder(inside), parseAttemptFolder(inside));
    records.delete(inside);
  };
  const insideOf = (path: string): string =>
    path
      .slice(root.length + 1)
      .split(/[\\/]/)
      .join('/');
  const recordedAt = (record: string): string | undefined =>
    [...records.keys()].find((inside) => recordOf(inside) === record);

  /** Carries out one step of a clean, as the real manager's shell does. */
  const carryOut = (life: Life, action: Action): string | undefined => {
    switch (action.kind) {
      case 'remove':
      case 'finish': {
        // git worktree remove: the folder goes, then its record.
        const inside = insideOf(action.path);
        removeFolder(inside);
        life.point('while cleaning worktrees');
        const record = action.record === undefined ? undefined : recordedAt(action.record);
        if (record !== undefined) removeRecord(record);
        return `removed worktree ${action.label}`;
      }
      case 'prune': {
        const record = recordedAt(action.record);
        if (record !== undefined) removeRecord(record);
        return `pruned stale worktree ${action.label}`;
      }
      case 'remove-folder':
        removeFolder(insideOf(action.path));
        return `removed folder ${action.label}`;
      case 'remove-batch-folder':
        return `removed batch folder ${action.label}`;
      case 'delete-branch': {
        if (branches.get(action.branch) !== action.tip) return undefined;
        const batchId = action.branch.split('/')[1] ?? '';
        removing(`the branch ${action.branch}`, batchId, parseAttemptBranch(action.branch));
        branches.delete(action.branch);
        return `deleted branch ${action.branch}`;
      }
      case 'index-lock':
        return undefined;
      default: {
        const unknown: never = action;
        throw new Error(`Unknown action ${JSON.stringify(unknown)}`);
      }
    }
  };

  /** The attempt worktree manager of the driver process of `life`. */
  const manager = (life: Life): Pick<AttemptWorktrees, 'root' | 'create' | 'clean'> => ({
    root,
    async create(ref, base): Promise<AttemptWorktree> {
      life.alive();
      if (base !== 'origin/main') throw new Error(`The base ${base} is no commit in the clone`);
      const inside = attemptFolder(ref);
      const branch = attemptBranch(ref);
      const path = pathOf(inside);
      const here = listed().find((worktree) => worktree.inside === inside);
      const checkedOutAt = listed().find(
        (worktree) => worktree.branch === branch && worktree.inside !== inside,
      )?.path;
      const facts = {
        listed: here,
        folderExists: folders.has(inside),
        branchTip: branches.get(branch),
        checkedOutAt,
      };
      const key = attemptKey.encode(ref);
      const plan = planWorktree(ref, facts, { kind: 'new', base: chaosBase });
      switch (plan.kind) {
        case 'reuse':
          made.push({ key, how: 'reused' });
          life.point('after a worktree was made');
          return { path, branch, commit: chaosBase };
        case 'refuse':
          made.push({ key, how: 'refused' });
          throw new Error(`Attempt ${inside} cannot get its worktree: ${plan.reason}`);
        case 'add': {
          if (plan.prune !== undefined) {
            // The attempt's own stale record goes before its worktree is made again (ADR 0037);
            // any other record is checked like every removal.
            const record = recordedAt(plan.prune);
            if (record === inside) records.delete(record);
            else if (record !== undefined) removeRecord(record);
          }
          // git worktree add: the branch, the record, then the folder with its checkout.
          if (plan.newBranch) branches.set(branch, chaosBase);
          life.point('while making a worktree');
          records.set(inside, branch);
          life.point('while making a worktree');
          folders.add(inside);
          made.push({ key, how: 'added' });
          life.point('after a worktree was made');
          return { path, branch, commit: chaosBase };
        }
        default: {
          const unknown: never = plan;
          throw new Error(`Unknown plan ${JSON.stringify(unknown)}`);
        }
      }
    },
    async clean(claims, scope = {}): Promise<CleanReport> {
      life.alive();
      const batchFolders = new Map<string, string[]>();
      for (const inside of folders) {
        const [batchId = '', ...rest] = inside.split('/');
        batchFolders.set(batchId, [...(batchFolders.get(batchId) ?? []), rest.join('/')]);
      }
      const facts: Facts = {
        worktrees: listed(),
        branches: [...branches].map(([name, tip]) => ({ name, tip })),
        folders: [...batchFolders].map(
          ([batchId, attempts]): BatchFolderFact => ({ batchId, attempts, withGit: attempts }),
        ),
      };
      const plan = planClean(facts, claims, root, scope);
      const report: CleanReport = { done: [], kept: plan.kept, failed: [] };
      for (const action of plan.actions) {
        // A worktree's branch is deleted only once the worktree is gone.
        const steps: Action[] = [action];
        if ('branch' in action && action.kind !== 'delete-branch' && action.branch !== undefined) {
          const { name, tip } = action.branch;
          steps.push({ kind: 'delete-branch', branch: name, tip });
        }
        for (const step of steps) {
          life.point('while cleaning worktrees');
          const line = carryOut(life, step);
          if (line !== undefined) report.done.push(line);
        }
      }
      cleaned.push({ batchId: scope.batchId, done: report.done, kept: report.kept });
      return report;
    },
  });

  /** What of `batchId` is still in the clone. */
  const leftovers = (batchId: string): Leftovers => {
    const ofBatch = (inside: string): boolean => batchOfFolder(inside) === batchId;
    return {
      records: [...records.keys()].filter(ofBatch),
      folders: [...folders].filter(ofBatch),
      branches: [...branches.keys()].filter((name) => name.split('/')[1] === batchId),
    };
  };

  return {
    manager,
    violations,
    made,
    cleaned,
    leftovers,
    /** The batches anything in the clone belongs to. */
    batches: (): string[] => [
      ...new Set([
        ...[...records.keys(), ...folders].map(batchOfFolder),
        ...[...branches.keys()].map((name) => name.split('/')[1] ?? ''),
      ]),
    ],
    /** Notes an attempt whose runner starts without its worktree on its branch. */
    starting: (ref: AttemptRef): void => {
      const inside = attemptFolder(ref);
      const branch = attemptBranch(ref);
      if (!folders.has(inside) || records.get(inside) !== branch || !branches.has(branch)) {
        violations.push(`${attemptKey.encode(ref)} started without its worktree`);
      }
    },
  };
};
export type FakeClone = ReturnType<typeof fakeClone>;
