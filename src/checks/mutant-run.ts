// Brett's mutants run around the brewer runner (ADR 0017, ADR 0040, ADR 0313): once a Brett
// attempt's session succeeded, the engine checks each mutant against the batch's change, runs the
// test check once in a scratch tree of the attempt's commit as the baseline, and once per valid
// mutant in a fresh scratch tree with the mutant's edit, and records each mutant's verdict on the
// attempt's end. The attempt succeeds whatever the verdicts.

import { type AttemptRef, attemptKey } from '../engine/attempt-key.ts';
import { mergedBase } from '../engine/base-merge.ts';
import type { AttemptEnd, AttemptStart, BrewerRunner } from '../engine/brewer-runner.ts';
import type { State } from '../engine/fold.ts';
import type { AttemptProgress } from '../engine/supervisor.ts';
import type { DiffFile } from '../formats/unified-diff.ts';
import { messageOf } from '../platform/errors.ts';
import { foldsCase } from '../platform/paths.ts';
import { MAX_MUTANT_TEXT, type MutantRecord, type MutantVerdict } from '../schemas/events.ts';
import { type MutantEdit, mutantsOf } from '../schemas/out-doc.ts';
import type { Git } from '../workspace/git.ts';
import type { CommitTree, TreeEdit } from '../workspace/merge-tree-git.ts';
import type { TestRun, TestRunEnd, TreeIn } from './check-runner.ts';
import { keptName } from './gravity.ts';
import { judgeRun } from './mutant-verdict.ts';
import { type ChangedFile, editFile, isPlainPath, mutantCheck } from './mutants.ts';
import { readDiff } from './step-commits.ts';
import { areaOf, type EffectiveModule, effectiveMap, type ReadTestMapAt } from './test-map.ts';

export interface MutantRunOptions {
  runner: BrewerRunner;
  /** The folded state: the driver's, which has recorded the attempt's start and worktree. */
  state: () => State;
  /** Whether attempt `ref`'s brewer writes the out doc schema `mutants` (ADR 0311). */
  mutates: (ref: AttemptRef) => boolean;
  git: Git;
  /** The clone a repository's attempt worktrees are added to, where git reads the change. */
  clone: (repo: string) => string;
  /** A repository's test map by commit (ADR 0274). */
  testMap: ReadTestMapAt;
  /** A scratch worktree of a commit of a repository (ADR 0313). */
  tree: (repo: string) => CommitTree;
  /** The test check run in a scratch tree (ADR 0313). */
  testRun: TestRun;
  /** Whose file system's case rule the map's globs are matched by. Default this process's. */
  platform?: NodeJS.Platform;
  /** Default the system clock. */
  clock?: () => Date;
}

/** How long before the step's deadline the last run must end, so the attempt ends in time. */
const DEADLINE_MARGIN_MS = 60_000;

/** A mutant's run may take this many times the baseline's, and never less than `LEAST_RUN_MS`. */
const RUN_FACTOR = 3;
const LEAST_RUN_MS = 60_000;

/** As much of a changed file as a diff may hold, and how long git may take to read it. */
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const READ_MS = 10_000;

const notJudged = (why: string): MutantVerdict => ({
  kind: 'notJudged',
  why: keptName(why, MAX_MUTANT_TEXT),
});

/** A mutant as the event keeps it: its texts on one line, cut, a secret left out. */
const recordOf = (mutant: MutantEdit, line: number, verdict: MutantVerdict): MutantRecord => ({
  file: keptName(mutant.file, MAX_MUTANT_TEXT),
  line,
  description: keptName(mutant.description, MAX_MUTANT_TEXT),
  verdict,
});

/** Why git failed: its last line on stderr, or how it ended. */
const gitFailed = (stderr: string, code: number | null): string =>
  stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .at(-1) ?? `git exited with ${code ?? 'no code'}`;

/** What a mutant's change is checked against: the effective map's modules and the changed files. */
interface Change {
  modules: EffectiveModule[];
  files: readonly DiffFile[];
  /** Each mutant's file at the commit, or why git could not read it. */
  contents: Map<string, { content: string } | { error: string }>;
}

export function mutated(options: MutantRunOptions): BrewerRunner {
  const { runner, state, mutates, git, clone, testMap, tree, testRun } = options;
  const { clock = () => new Date() } = options;
  const foldCase = foldsCase(options.platform);
  // The attempts whose mutants it runs: the engine's own work, live as long as it lasts, so their
  // leases hold and no test run reads as a stalled brewer (ADR 0027).
  const judging = new Set<string>();

  /** The batch's change in `repo`, from where it started to `commit`, or why it cannot be read. */
  const changeOf = async (
    batchId: string,
    repo: string,
    commit: string,
    mutants: readonly MutantEdit[],
    signal: AbortSignal,
  ): Promise<Change | { why: string }> => {
    const batch = state().batches.get(batchId);
    // Where the batch's change starts: the base it merged, else its start (ADR 0164).
    const base = mergedBase(state(), batchId) ?? batch?.starts?.[repo.toLowerCase()]?.commit;
    if (base === undefined) return { why: `the batch has no start in ${repo}` };
    const cwd = clone(repo);
    const diff = await readDiff(git, cwd, { from: base, to: commit }, { signal });
    if ('error' in diff) return { why: `the change of the batch cannot be read: ${diff.error}` };
    const [before, after] = [
      await testMap(repo, base, signal),
      await testMap(repo, commit, signal),
    ];
    // Named by where, never by its commit: the event's secret filter leaves a hash out.
    for (const [read, at] of [
      [before, 'where the batch started'],
      [after, "at the attempt's commit"],
    ] as const) {
      if (read.kind === 'unreadable') {
        return { why: `the test map of ${repo} ${at} cannot be read: ${read.reason}` };
      }
    }
    if (after.kind !== 'map' && before.kind !== 'map') return { why: `${repo} has no test map` };
    const modules = effectiveMap(
      before.kind === 'map' ? before.map : undefined,
      after.kind === 'map' ? after.map : undefined,
      { atBase: [], deleted: [] },
      foldCase,
    );
    // Only the files a mutant names that the change added a line to are read, by their path at
    // the commit: a name that is no plain path is the mutant check's to refuse.
    const contents = new Map<string, { content: string } | { error: string }>();
    for (const { file } of mutants) {
      if (contents.has(file) || !isPlainPath(file)) continue;
      const changed = diff.files.some(
        ({ newPath, addedAt = [] }) => newPath === file && addedAt.length > 0,
      );
      if (!changed) continue;
      const options = { maxOutputBytes: MAX_FILE_BYTES, timeoutMs: READ_MS, signal };
      const read = await git(cwd, ['cat-file', 'blob', `${commit}:${file}`], options);
      contents.set(
        file,
        read.code === 0 ? { content: read.stdout } : { error: gitFailed(read.stderr, read.code) },
      );
    }
    return { modules, files: diff.files, contents };
  };

  /** `end` with each mutant's verdict, or as it was for an attempt that runs none. */
  const judge = async (
    ref: AttemptRef,
    end: AttemptEnd,
    signal: AbortSignal,
  ): Promise<AttemptEnd> => {
    if (end.ending.kind !== 'succeeded' || !mutates(ref)) return end;
    const proposed = mutantsOf(end.ending.output);
    if (proposed === undefined || proposed.length === 0) return end;
    const attempt = state()
      .batches.get(ref.batchId)
      ?.steps.get(ref.stepId)
      ?.attempts.get(ref.attempt);
    // A Brewery order's read-only attempt has checkouts, and no worktree to run (ADR 0301).
    const worktree = attempt?.phase === 'started' ? attempt.worktree : undefined;
    if (attempt === undefined || worktree === undefined) return end;
    const { repo, commit } = worktree;
    const lastEnd = Date.parse(attempt.deadlineAt) - DEADLINE_MARGIN_MS;
    judging.add(attemptKey.encode(ref));
    const ended = (verdicts: readonly MutantRecord[]): AttemptEnd =>
      signal.aborted ? { ...end, ending: { kind: 'cancelled' } } : { ...end, mutants: verdicts };

    const change = await changeOf(ref.batchId, repo, commit, proposed, signal);
    if ('why' in change) {
      return ended(proposed.map((mutant) => recordOf(mutant, mutant.line, notJudged(change.why))));
    }
    // Each mutant checked against the change (ADR 0311): valid ones run, in Brett's order.
    const target = {
      inCode: (path: string) => areaOf(change.modules, path, foldCase)?.area === 'code',
      changed: (path: string): ChangedFile | undefined => {
        const read = change.contents.get(path);
        const file = change.files.find(({ newPath }) => newPath === path);
        if (read === undefined || !('content' in read) || file === undefined) return undefined;
        return { content: read.content, added: new Set(file.addedAt ?? []) };
      },
    };
    const checked = proposed.map((mutant) => {
      const read = change.contents.get(mutant.file);
      // A file git could not read is neither changed nor unchanged: its mutant is not judged.
      if (read !== undefined && 'error' in read) {
        return { mutant, unread: `${mutant.file} cannot be read: ${read.error}` };
      }
      return { mutant, verdict: mutantCheck(mutant, target) };
    });
    const at = (path: string): TreeIn => ({ repo, path });
    const scratch = tree(repo);

    /** A run of the tests in a fresh scratch tree, the mutant's edit in it when one is given. */
    const runIn = async (until: number, edit?: TreeEdit): Promise<TestRunEnd> => {
      const deadline = new Date(until).toISOString();
      try {
        return await scratch(
          commit,
          (path) => testRun(at(path), change.modules, deadline, signal),
          edit === undefined ? { signal } : { signal, edit },
        );
      } catch (error) {
        return { kind: 'unrun', why: `its test run failed: ${messageOf(error)}` };
      }
    };

    const valid = checked.flatMap((each) =>
      'verdict' in each && each.verdict.ok ? [each.verdict] : [],
    );
    let baseline: TestRunEnd | undefined;
    let budget = LEAST_RUN_MS;
    if (valid.length > 0 && clock().getTime() < lastEnd) {
      const started = clock().getTime();
      baseline = await runIn(lastEnd);
      budget = Math.max(LEAST_RUN_MS, RUN_FACTOR * (clock().getTime() - started));
    }
    const records: MutantRecord[] = [];
    for (const each of checked) {
      const { mutant } = each;
      if (signal.aborted) break;
      if ('unread' in each) {
        records.push(recordOf(mutant, mutant.line, notJudged(each.unread)));
        continue;
      }
      const { verdict } = each;
      if (!verdict.ok) {
        const reason = keptName(verdict.reason, MAX_MUTANT_TEXT);
        records.push(recordOf(mutant, mutant.line, { kind: 'invalid', reason }));
        continue;
      }
      const record = (judged: MutantVerdict) =>
        records.push(recordOf(mutant, verdict.line, judged));
      if (baseline === undefined) {
        record(notJudged("the step's deadline came before the baseline could run"));
        continue;
      }
      if (baseline.kind === 'unrun') {
        record(notJudged(`the baseline did not run: ${baseline.why}`));
        continue;
      }
      if (baseline.reading.result !== 'exited') {
        record(notJudged(`the baseline's test check ended ${baseline.reading.result}`));
        continue;
      }
      const now = clock().getTime();
      if (now >= lastEnd) {
        record(notJudged("the step's deadline came before it could run"));
        continue;
      }
      const until = Math.min(lastEnd, now + budget);
      // The line edit on the file as git checked it out, so its line endings and encoding stay
      // those of the baseline's tree.
      const rewrite = (checkedOut: string): string => {
        const edited = editFile(mutant, checkedOut);
        if (!edited.ok) throw new Error(edited.reason);
        return edited.content;
      };
      const run = await runIn(until, { file: mutant.file, rewrite });
      if (run.kind === 'unrun') {
        record(notJudged(run.why));
        continue;
      }
      const { reading } = run;
      if (reading.result === 'killed' && reading.killed === 'timed-out') {
        // Its own deadline is a kill (ADR 0040); the step's says nothing of the mutant.
        record(
          until < lastEnd
            ? { kind: 'timedOut' }
            : notJudged("the step's deadline came before its run ended"),
        );
        continue;
      }
      if (reading.result !== 'exited') {
        record(notJudged(`its test check ended ${reading.result}`));
        continue;
      }
      const module = areaOf(change.modules, mutant.file, foldCase)?.module ?? '';
      const judged = judgeRun(baseline.reports, run.reports, module, reading.exitCode !== 0);
      switch (judged.kind) {
        case 'killed':
          // A test's name is the run's text: one of blanks only is said so.
          record({ kind: 'killed', by: keptName(judged.by) || '(a name of blanks)' });
          break;
        case 'notJudged':
          record(notJudged(judged.why));
          break;
        case 'survived':
          record(judged);
          break;
        default: {
          const unhandled: never = judged;
          throw new Error(`Unhandled verdict ${JSON.stringify(unhandled)}`);
        }
      }
    }
    return ended(records);
  };

  return {
    start: (attempt: AttemptStart) => {
      const { ref } = attempt;
      if (!mutates(ref)) return runner.start(attempt);
      const session = runner.start(attempt);
      const stop = new AbortController();
      return {
        ended: session.ended
          .then((end) => judge(ref, end, stop.signal))
          .finally(() => judging.delete(attemptKey.encode(ref))),
        stop: () => {
          stop.abort();
          session.stop();
        },
      };
    },
    progress: (ref): AttemptProgress | undefined =>
      runner.progress(ref) ??
      (judging.has(attemptKey.encode(ref))
        ? { lastProgressAt: clock(), turnsWithoutProgress: 0 }
        : undefined),
  };
}
