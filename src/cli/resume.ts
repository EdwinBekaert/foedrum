// `foedrum resume <batch> [<step>[#<n>]]` (ADR 0126): opens a finished brewer attempt's own Claude
// Code session in its worktree, with its settings file written again, while the batch's and the
// attempt's leases claim it. resume-main.ts gives it the real machine; unit tests give fakes.

import { join } from 'node:path';
import { attemptPermissions, modelOf, settingsFileOf, toolsOf } from '../brewers/attempt-plan.ts';
import { attemptSettings } from '../brewers/attempt-settings.ts';
import { resumeArgs } from '../brewers/claude-command.ts';
import { type AttemptRef, attemptKey } from '../engine/attempt-key.ts';
import { defaultLeaseMs, holdBatch, releaseBatch } from '../engine/batch-leases.ts';
import type { EventStore, StoredEvent } from '../engine/event-store.ts';
import { fold, type State } from '../engine/fold.ts';
import { sameRepo } from '../engine/task-tree.ts';
import type { AttemptSettings } from '../schemas/attempt-settings.ts';
import type { ResumeCommand } from '../schemas/commands.ts';
import type { SessionRef, WorktreeRef } from '../schemas/events.ts';
import type { AttemptWorktrees } from '../workspace/attempt-worktrees-git.ts';
import type { CliResult } from './run.ts';
import type { ServeRepository, ServeSetup } from './serve-config.ts';

/** What resume needs of serve's setup: where the attempts ran and how their brewers are set up. */
export type ResumeSetup = Pick<
  ServeSetup,
  'workRoot' | 'repositories' | 'models' | 'brewers' | 'claude' | 'sandbox'
>;

/** What resume needs from the machine. */
export interface ResumeShell {
  /** The Brewery's root: the event store is `.foedrum/index.db` in it. */
  cwd: string;
  /** Opens the event store for writing its leases, or `undefined` when there is none. */
  openStore: (path: string) => EventStore | undefined;
  /** Serve's setup of the Brewery, or serve's problems. */
  setup: () => Promise<
    { kind: 'ready'; setup: ResumeSetup } | { kind: 'refused'; problems: string[] }
  >;
  /** The attempt worktrees of a repository. */
  worktrees: (repository: ServeRepository) => Promise<Pick<AttemptWorktrees, 'recreate'>>;
  /** Whether Claude Code keeps the session `id` on this machine. */
  sessionFound: (id: string) => boolean;
  /** Writes an attempt's settings file, making its folder. */
  writeSettings: (file: string, settings: AttemptSettings) => void;
  /** Whether this runs inside a Claude Code session, which cannot hand its terminal over. */
  nested: boolean;
  /** Runs `program` in the foreground in `cwd` with the terminal's stdio; its exit code. */
  claude: (program: string, args: readonly string[], cwd: string) => Promise<number>;
  now: () => Date;
  /** Calls `beat` every `everyMs` until the returned function is called. */
  heartbeat: (everyMs: number, beat: () => void) => () => void;
  /** This process's id, which names the leases' owner. */
  pid: number;
}

/** The attempt resume opens: its session and the worktree it ran in. */
interface Target {
  ref: AttemptRef;
  session: SessionRef;
  worktree: WorktreeRef;
}

type Refused = { refused: string };

const labelOf = ({ stepId, attempt }: AttemptRef): string => `${stepId}#${attempt}`;

// The attempt `ref` when it finished with a session and a worktree, or why not.
const finishedTarget = (state: State, ref: AttemptRef): Target | Refused => {
  const attempt = state.batches.get(ref.batchId)?.steps.get(ref.stepId)?.attempts.get(ref.attempt);
  const named = `attempt ${labelOf(ref)} of batch ${ref.batchId}`;
  if (attempt === undefined) {
    return { refused: `batch ${ref.batchId} has no attempt ${labelOf(ref)}` };
  }
  if (attempt.phase !== 'finished') return { refused: `${named} has not finished` };
  const { session, worktree } = attempt;
  if (session === undefined || worktree === undefined) {
    return { refused: `${named} ran no brewer: it has no session` };
  }
  return { ref, session, worktree };
};

/**
 * The attempt `foedrum resume` opens (ADR 0126): the one `step` names as `<step>#<n>`, else the
 * latest that started with a session and finished, in the order of the log, of the step or of
 * the batch. A running batch is refused: taking one over is #338.
 */
const targetOf = (
  events: readonly StoredEvent[],
  state: State,
  batchId: string,
  step: string | undefined,
): Target | Refused => {
  const batch = state.batches.get(batchId);
  if (batch === undefined) return { refused: `no batch ${batchId} in the event store` };
  if (batch.lane.kind === 'ordered' || batch.lane.kind === 'brewing') {
    const running = `batch ${batchId} is ${batch.lane.kind}`;
    return { refused: `${running}; resuming a running batch is not supported yet (#338)` };
  }
  const at = step?.lastIndexOf('#') ?? -1;
  const stepId = at < 0 ? step : step?.slice(0, at);
  if (stepId !== undefined && !batch.steps.has(stepId)) {
    return { refused: `batch ${batchId} has no attempt of step ${stepId}` };
  }
  if (stepId !== undefined && at >= 0) {
    return finishedTarget(state, { batchId, stepId, attempt: Number(step?.slice(at + 1)) });
  }
  const starts = events.flatMap(({ event }) =>
    event.type === 'step.started' &&
    event.batchId === batchId &&
    (stepId === undefined || event.stepId === stepId)
      ? [{ batchId, stepId: event.stepId, attempt: event.attempt }]
      : [],
  );
  for (const ref of starts.reverse()) {
    const target = finishedTarget(state, ref);
    if (!('refused' in target)) return target;
  }
  const of = stepId === undefined ? '' : ` of step ${stepId}`;
  return { refused: `batch ${batchId} has no finished attempt${of} that ran a brewer` };
};

const failed = (line: string): CliResult => ({
  exitCode: 1,
  stdout: '',
  stderr: `foedrum resume: ${line}\n`,
});

/** Runs `foedrum resume`: claude's exit code, or one line on why it opened nothing. */
export const runResume = async (input: ResumeCommand, shell: ResumeShell): Promise<CliResult> => {
  const path = join(shell.cwd, '.foedrum', 'index.db');
  const store = shell.openStore(path);
  if (store === undefined) return failed(`no event store at ${path}`);
  try {
    const events = store.eventsAfter(0);
    const state = fold(events.map(({ event }) => event));
    const target = targetOf(events, state, input.batch, input.step);
    if ('refused' in target) return failed(target.refused);
    const { ref, session, worktree } = target;
    const { batchId } = ref;
    const label = `${batchId} ${labelOf(ref)}`;
    // A Claude Code session cannot hand its terminal to claude: the engineer runs it in one.
    if (shell.nested) {
      const run = `run this in a terminal in ${shell.cwd}:\n  foedrum resume ${label}\n`;
      const why =
        'foedrum resume opens claude in a terminal, which a Claude Code session cannot hand over';
      return { exitCode: 0, stdout: `${why}; ${run}`, stderr: '' };
    }
    if (!shell.sessionFound(session.id)) {
      const kept = 'Claude Code keeps a session where it ran, for 30 days by default';
      return failed(`the session ${session.id} of ${label} is not on this machine: ${kept}`);
    }
    const ready = await shell.setup();
    if (ready.kind === 'refused') {
      const stderr = ready.problems.map((problem) => `foedrum resume: ${problem}\n`).join('');
      return { exitCode: 1, stdout: '', stderr };
    }
    const { setup } = ready;
    const repository = setup.repositories.find(({ repo }) => sameRepo(repo, worktree.repo));
    if (repository === undefined) {
      return failed(`${worktree.repo} is no repository of this Brewery`);
    }
    const recipe = state.batches.get(batchId)?.recipe?.name ?? '';
    const found = setup.brewers.find(recipe, ref.stepId);
    if (found === undefined) return failed(`recipe ${recipe} has no step ${ref.stepId}`);

    // The batch's lease keeps every driver and another resume out; the attempt's makes the
    // cleanup keep its worktree, also of an ended batch (worktreeClaims).
    const owner = `resume-${shell.pid}`;
    const key = attemptKey.encode(ref);
    const hold = () =>
      store.withTransaction((tx) => {
        const held = holdBatch(tx, { batchId, owner, now: shell.now(), leaseMs: defaultLeaseMs });
        if (held.kind === 'held') {
          tx.putLease({ attemptKey: key, owner, expiresAt: held.lease.expiresAt });
        }
        return held;
      });
    const held = hold();
    if (held.kind === 'other') {
      const { owner: holder, expiresAt } = held.lease;
      return failed(`batch ${batchId} is held by ${holder} until ${expiresAt.toISOString()}`);
    }
    const stop = shell.heartbeat(defaultLeaseMs / 3, hold);
    try {
      const { recreate } = await shell.worktrees(repository);
      const { path: folder } = await recreate(ref, worktree.commit);
      const permissions = attemptPermissions(found.brewer, repository.tools, setup.sandbox);
      const settingsFile = settingsFileOf(setup.workRoot, ref);
      shell.writeSettings(settingsFile, attemptSettings(permissions));
      const args = resumeArgs({
        model: modelOf(setup.models, found.brewer),
        effort: found.brewer.effort,
        settingsFile,
        tools: toolsOf(permissions.allow),
        sessionId: session.id,
      });
      return { exitCode: await shell.claude(setup.claude, args, folder), stdout: '', stderr: '' };
    } finally {
      stop();
      store.withTransaction((tx) => {
        releaseBatch(tx, batchId, owner);
        tx.releaseLease(key);
      });
    }
  } finally {
    store.close();
  }
};
