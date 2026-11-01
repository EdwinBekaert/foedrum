// The Maltster's survey around the brewer runner (ADR 0282, ADR 0298): before a survey's session
// starts, it reads the test map at the attempt's base and its manifests in the worktree, and ends
// the attempt as succeeded with no session when the map is fresh, or kept by the Brewery, which a
// survey cannot write. After an attempt of a brewer with the testMapOnly guard, it fails the
// attempt when its commits changed anything but the test map.

import { type AttemptRef, attemptKey } from '../engine/attempt-key.ts';
import type { AttemptEnd, AttemptStart, BrewerRunner } from '../engine/brewer-runner.ts';
import type { State } from '../engine/fold.ts';
import type { AttemptProgress } from '../engine/supervisor.ts';
import { type SurveyMap, surveyOf } from '../schemas/out-doc.ts';
import { attemptBranch } from '../workspace/attempt-worktrees.ts';
import type { Git } from '../workspace/git.ts';
import {
  manifestFreshness,
  type ReadManifestFreshness,
  type ReadTestMapAt,
  TEST_MAP_PATH,
} from './test-map.ts';

export interface SurveyOptions {
  runner: BrewerRunner;
  /** The folded state: the driver's, which has recorded the attempt's start and worktree. */
  state: () => State;
  /** Whether attempt `ref` is a survey's: its brewer answers with the out doc schema `survey`. */
  surveys: (ref: AttemptRef) => boolean;
  /** Whether attempt `ref`'s brewer has the testMapOnly guard. */
  mapOnly: (ref: AttemptRef) => boolean;
  /** A repository's test map by commit (ADR 0274). */
  testMap: ReadTestMapAt;
  /** Where a repository's map is kept (ADR 0018). */
  keptIn: (repo: string) => 'repo' | 'brewery';
  /** A map's manifests against a worktree's files (ADR 0282); default git's. */
  manifests?: ReadManifestFreshness;
  git: Git;
  /** The clone a repository's attempt worktrees are added to, where git reads the commits. */
  clone: (repo: string) => string;
  /** Default the system clock. */
  clock?: () => Date;
}

/** How long git may take to list the files an attempt's commits changed. */
const LIST_MS = 30_000;

/** The most files the guard names. */
const MOST_NAMED = 10;

/** A survey's end with no session: its out doc, as a brewer would have written it. */
const noSession = (map: Extract<SurveyMap, 'fresh' | 'brewery'>, summary: string): AttemptEnd => {
  const output = { status: 'done', summary, map };
  return {
    ending: { kind: 'succeeded', output },
    outDoc: `---\n${JSON.stringify(output, null, 2)}\n---\n${summary}\n`,
  };
};

const blocked = (summary: string): AttemptEnd => ({
  ending: { kind: 'blocked', blockerKind: 'environment', summary },
});

/** Why git failed: its last line on stderr, or how it ended. */
const gitFailed = (stderr: string, code: number | null): string =>
  stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .at(-1) ?? `git exited with ${code ?? 'no code'}`;

export function surveyed(options: SurveyOptions): BrewerRunner {
  const { runner, state, surveys, mapOnly, testMap, keptIn, git, clone } = options;
  const { clock = () => new Date() } = options;
  const manifests = options.manifests ?? manifestFreshness(git);
  // The attempts whose map or commits it is reading: it reports their progress, so their leases hold.
  const reading = new Map<string, AttemptProgress>();

  const worktreeOf = (ref: AttemptRef) => {
    const current = state()
      .batches.get(ref.batchId)
      ?.steps.get(ref.stepId)
      ?.attempts.get(ref.attempt);
    return current?.phase === 'started' ? current.worktree : undefined;
  };

  /** How a survey ends before its session, or undefined when the Maltster's session runs. */
  const before = async (ref: AttemptRef, signal: AbortSignal): Promise<AttemptEnd | undefined> => {
    const worktree = worktreeOf(ref);
    if (worktree === undefined) return undefined;
    const { repo } = worktree;
    // A survey cannot write the Brewery: its stale map is named, never refreshed (ADR 0282).
    if (keptIn(repo) === 'brewery') {
      return noSession(
        'brewery',
        `The Brewery keeps the test map of ${repo}: a survey cannot write it`,
      );
    }
    // Sent back by a route, such as its check's: the map in its worktree is the one that
    // disagreed, fresh by its own manifests, and the Maltster gets the reason (ADR 0128).
    const scheduled = state()
      .batches.get(ref.batchId)
      ?.steps.get(ref.stepId)
      ?.attempts.get(ref.attempt);
    if (scheduled?.route !== undefined) return undefined;
    const read = await testMap(repo, worktree.commit, signal);
    // No map, or one that cannot be read: the Maltster proposes one.
    if (read.kind !== 'map') return undefined;
    const found = await manifests(worktree.path, read.map, signal);
    switch (found.kind) {
      case 'fresh':
        return noSession(
          'fresh',
          `The test map of ${repo} is fresh: its manifests are as it records them`,
        );
      case 'unread':
        return blocked(
          `the manifests of the test map of ${repo} cannot be listed: ${found.reason}`,
        );
      case 'stale':
        return undefined;
      default: {
        const unhandled: never = found;
        throw new Error(`Unhandled freshness ${JSON.stringify(unhandled)}`);
      }
    }
  };

  /** `end`, or how the guard ends the attempt instead. */
  const after = async (
    ref: AttemptRef,
    end: AttemptEnd,
    signal: AbortSignal,
  ): Promise<AttemptEnd> => {
    if (end.ending.kind !== 'succeeded') return end;
    const failed = (reason: string): AttemptEnd => ({
      ...end,
      ending: { kind: 'failed', retryable: true, reason },
    });
    // Fresh and brewery are what the engine says before a survey runs, and what skips its check.
    const map = surveys(ref) ? surveyOf(end.ending.output)?.map : undefined;
    if (map === 'fresh' || map === 'brewery') {
      return failed(
        `the survey says its map is ${map}, which only Foedrum says before a survey runs: say new or stale (ADR 0298)`,
      );
    }
    const worktree = worktreeOf(ref);
    if (!mapOnly(ref) || worktree === undefined) return end;
    const tip = `refs/heads/${attemptBranch(ref)}`;
    const args = ['diff', '--name-only', '-z', '--no-renames', worktree.commit, tip];
    const result = await git(clone(worktree.repo), args, { timeoutMs: LIST_MS, signal });
    if (signal.aborted) return { ...end, ending: { kind: 'cancelled' } };
    if (result.code !== 0) {
      const why = gitFailed(result.stderr, result.code);
      return {
        ...end,
        ending: blocked(
          `the guard testMapOnly cannot read the commits of step ${ref.stepId}: ${why}`,
        ).ending,
      };
    }
    const others = result.stdout
      .split('\0')
      .filter((path) => path !== '' && path !== TEST_MAP_PATH);
    if (others.length === 0) return end;
    const more = others.length - MOST_NAMED;
    const named = `${others.slice(0, MOST_NAMED).join(', ')}${more > 0 ? ` and ${more} more` : ''}`;
    // Another attempt starts afresh at the task tree.
    return failed(
      `the guard testMapOnly: the attempt changed ${named}; it may change ${TEST_MAP_PATH} only (ADR 0298)`,
    );
  };

  const read = async <T>(ref: AttemptRef, work: () => Promise<T>): Promise<T> => {
    const key = attemptKey.encode(ref);
    reading.set(key, { lastProgressAt: clock(), turnsWithoutProgress: 0 });
    try {
      return await work();
    } finally {
      reading.delete(key);
    }
  };

  return {
    start: (attempt: AttemptStart) => {
      const { ref } = attempt;
      if (!surveys(ref) && !mapOnly(ref)) return runner.start(attempt);
      const stop = new AbortController();
      let running: ReturnType<BrewerRunner['start']> | undefined;
      const ended = (async (): Promise<AttemptEnd> => {
        const early = surveys(ref) ? await read(ref, () => before(ref, stop.signal)) : undefined;
        if (stop.signal.aborted) return { ending: { kind: 'cancelled' } };
        if (early !== undefined) return early;
        running = runner.start(attempt);
        const end = await running.ended;
        return read(ref, () => after(ref, end, stop.signal));
      })();
      return {
        ended,
        stop: () => {
          stop.abort();
          running?.stop();
        },
      };
    },
    progress: (ref) => runner.progress(ref) ?? reading.get(attemptKey.encode(ref)),
  };
}
