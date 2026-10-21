// An in-memory state branch for the chaos harness (#144, ADR 0011, ADR 0024): the state worktree's
// files, its local commits and the remote branch, which outlive every driver process as a disk and
// a remote do. A driver process's handle does what the shell (state-branch-git.ts) does at its
// start and at a flush, in the same order, with the pure core deciding (`decideStart`,
// `planFlush`, `mergeLogs`, `planCatchUp`) and the store keeping the pushed-through marker, and a
// kill point between the steps that a crash could fall between. No git runs (ADR 0021): the
// shell's git calls are what the state branch's integration tests cover.

import type { EventStore, KeptOutDoc } from '../../src/engine/event-store.ts';
import {
  decideStart,
  isLogPath,
  logPathOf,
  mergeLogs,
  outDocPath,
  planCatchUp,
  planFlush,
  type StartDecision,
  StateBranchStopError,
} from '../../src/engine/state-branch.ts';
import type { FlushResult, StartResult, StateBranch } from '../../src/engine/state-branch-git.ts';
import type { Life } from './chaos.ts';

export const stateBranchKillPoints = [
  'while writing the log',
  'before the push reached the remote',
  'after the push reached the remote',
  // Between an attempt's out doc kept in the store and its step.finished (ADR 0103).
  'after an out doc was kept',
] as const;
export type StateBranchKillPoint = (typeof stateBranchKillPoints)[number];

const remoteBranch = 'origin/foedrum/state';

interface Commit {
  parent: string | undefined;
  files: ReadonlyMap<string, string>;
}

/** A line of a log file on the branch, as the checks read it, without the core's parser. */
export interface BranchLine {
  path: string;
  id: number;
  event: unknown;
}

/**
 * `lastKill`: the kill point of the run's last kill so far, if any. `outDocs`: a flush also writes
 * the out docs the store kept, as the shell does (ADR 0103).
 */
export const fakeStateBranch = (
  lastKill: () => string | undefined,
  { outDocs = false }: { outDocs?: boolean } = {},
) => {
  // The state worktree's files, as on disk.
  const files = new Map<string, string>();
  const commits = new Map<string, Commit>();
  let localHead: string | undefined;
  let remoteHead: string | undefined;
  let made = 0;
  /** What each start decided, in order, and the kill point of the run's last kill before it. */
  const starts: {
    decision: StartDecision['kind'];
    after: string | undefined;
    /** How many out docs the store kept as it started, in the runs that keep them. */
    keptOutDocs: number;
  }[] = [];
  /** The out docs a store kept, by their path on the branch: what the branch must come to hold. */
  const kept = new Map<string, string>();
  /** The starts that ended with events committed before them still not on the remote. */
  const behind: string[] = [];

  const isAncestor = (commit: string, of: string): boolean => {
    for (let at: string | undefined = of; at !== undefined; at = commits.get(at)?.parent) {
      if (at === commit) return true;
    }
    return false;
  };
  const logFiles = (snapshot: ReadonlyMap<string, string>): { path: string; text: string }[] =>
    [...snapshot].filter(([path]) => isLogPath(path)).map(([path, text]) => ({ path, text }));
  const changedSince = (head: string | undefined): boolean => {
    const before = head === undefined ? new Map<string, string>() : commits.get(head)?.files;
    return (
      before === undefined ||
      before.size !== files.size ||
      [...files].some(([path, text]) => before.get(path) !== text)
    );
  };

  /** Every line of the log files at the remote branch's commit, file by file. */
  const remoteLines = (): BranchLine[] => {
    const remote = remoteHead === undefined ? undefined : commits.get(remoteHead);
    return [...(remote?.files ?? [])].flatMap(([path, text]) =>
      path.endsWith('events.jsonl')
        ? text
            .split('\n')
            .filter((line) => line !== '')
            .map((line) => {
              const { id, event } = JSON.parse(line) as { id: number; event: unknown };
              return { path, id, event };
            })
        : [],
    );
  };

  /** The state branch of the driver process of `life`, on its view of the store. */
  const handle = (life: Life, store: EventStore): Pick<StateBranch, 'start' | 'flush'> => {
    const flushNow = async (checkAll: boolean): Promise<FlushResult> => {
      life.alive();
      const from = store.pushedThrough()?.eventId ?? 0;
      const pending = store.eventsAfter(from);
      const last = pending.at(-1);
      if (last === undefined) return { kind: 'unchanged' };
      // Read after the events: the out doc of a pending step.finished was kept before it.
      const docs = outDocs ? store.keptOutDocs() : [];
      const paths = new Set(pending.map((stored) => logPathOf(stored.event)));
      if (checkAll) for (const { path } of logFiles(files)) paths.add(path);
      const current = new Map([...paths].map((path) => [path, files.get(path)] as const));
      // Each file is written whole next to its place and renamed; a kill falls between files.
      for (const file of planFlush(current, pending, from, docs)) {
        life.point('while writing the log');
        files.set(file.path, file.text);
      }
      if (changedSince(localHead)) {
        const commit = (++made).toString(16).padStart(40, '0');
        commits.set(commit, { parent: localHead, files: new Map(files) });
        localHead = commit;
      }
      const commit = localHead;
      if (commit === undefined) throw new Error('The state worktree has no commit');
      life.point('before the push reached the remote');
      if (remoteHead !== undefined && !isAncestor(remoteHead, commit)) {
        throw new StateBranchStopError(`Another engine pushed to the state branch: ${remoteHead}`);
      }
      remoteHead = commit;
      // The push landed; the process dies before it hears so.
      life.point('after the push reached the remote');
      store.withTransaction((tx) => {
        tx.markPushed({ eventId: last.id, commit });
        if (docs.length > 0) tx.forgetOutDocs(docs);
      });
      return { kind: 'pushed', through: last.id, commit };
    };
    const startNow = async (): Promise<StartResult> => {
      life.alive();
      const pushed = store.pushedThrough();
      const pushedReachesRemote =
        pushed !== undefined && remoteHead !== undefined && isAncestor(pushed.commit, remoteHead);
      const decision = decideStart({
        branch: remoteBranch,
        lastEventId: store.lastEventId(),
        pushed,
        localHead,
        remoteHead,
        pushedReachesRemote,
      });
      const keptOutDocs = outDocs ? store.keptOutDocs().length : 0;
      starts.push({ decision: decision.kind, after: lastKill(), keptOutDocs });
      switch (decision.kind) {
        case 'ready':
          return { decision: 'ready' };
        case 'flush':
          return { decision: 'flush', flush: await flushNow(localHead !== pushed?.commit) };
        case 'restore': {
          const remote = remoteHead === undefined ? undefined : commits.get(remoteHead);
          if (remote === undefined || remoteHead === undefined) {
            throw new Error('A restore needs the remote branch');
          }
          localHead = remoteHead;
          files.clear();
          for (const [path, text] of remote.files) files.set(path, text);
          store.restore(planCatchUp(mergeLogs(logFiles(files)), store.eventsAfter(0)), remoteHead);
          return { decision: 'restore' };
        }
        case 'stop':
          throw new StateBranchStopError(decision.reason);
        default: {
          const unknown: never = decision;
          throw new Error(`Unknown start decision ${JSON.stringify(unknown)}`);
        }
      }
    };
    return {
      // A start brings the store and the branch in line (ADR 0024): what was committed before it
      // is on the remote once it is done.
      start: async () => {
        const last = store.lastEventId();
        const result = await startNow();
        const pushed = Math.max(0, ...remoteLines().map(({ id }) => id));
        if (pushed < last) {
          behind.push(`a start (${result.decision}) left events ${pushed + 1}–${last} unpushed`);
        }
        return result;
      },
      flush: () => flushNow(false),
    };
  };

  /**
   * The store a driver process of `life` keeps out docs through: each one it committed is noted
   * in `kept`, also when the process dies right after, and the process may die then (ADR 0103).
   * `committed` reads the store as a process beside the drivers sees it.
   */
  const keeping = (
    life: Life,
    store: EventStore,
    committed: () => readonly KeptOutDoc[],
  ): Pick<EventStore, 'withTransaction'> => ({
    withTransaction: (fn) => {
      const docs: KeptOutDoc[] = [];
      let result: ReturnType<typeof fn>;
      try {
        result = store.withTransaction((tx) =>
          fn({
            ...tx,
            keepOutDoc: (doc) => {
              tx.keepOutDoc(doc);
              docs.push(doc);
            },
          }),
        );
      } finally {
        const now = committed();
        for (const doc of docs) {
          const same = now.some(
            (other) =>
              other.batchId === doc.batchId &&
              other.stepId === doc.stepId &&
              other.attempt === doc.attempt &&
              other.text === doc.text,
          );
          if (same) kept.set(outDocPath(doc), doc.text);
        }
      }
      if (docs.length > 0) life.point('after an out doc was kept');
      return result;
    },
  });

  /** The files at the remote branch's commit, by path. */
  const remoteFiles = (): ReadonlyMap<string, string> =>
    (remoteHead === undefined ? undefined : commits.get(remoteHead)?.files) ?? new Map();

  return {
    handle,
    keeping,
    kept,
    remoteFiles,
    starts,
    /** Whether `commit` is the remote branch's commit or one of its ancestors. */
    onRemote: (commit: string): boolean =>
      remoteHead !== undefined && isAncestor(commit, remoteHead),
    remoteLines,
    behind,
  };
};
export type FakeStateBranch = ReturnType<typeof fakeStateBranch>;
