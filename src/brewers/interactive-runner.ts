// The brewer runner of `foedrum resume` on a running batch (ADR 0127): an attempt that resumes a
// session runs as the engineer's interactive `claude --resume` in the foreground, with the
// attempt's settings, guards and environment, and ends by the out doc the session wrote, through
// settleAttempt as every run does. An attempt that starts fresh runs headless, as its driver would.

import { resolve } from 'node:path';
import { passed, settleReadings } from '../checks/gravity.ts';
import { attemptKey } from '../engine/attempt-key.ts';
import { buildBrewerEnv } from '../engine/brewer-env.ts';
import {
  type AttemptEnd,
  type AttemptFacts,
  type AttemptStart,
  type BrewerRunner,
  type ProcessExit,
  settleAttempt,
} from '../engine/brewer-runner.ts';
import type { ExecProcess } from '../platform/processes.ts';
import type { AttemptSettings } from '../schemas/attempt-settings.ts';
import type { GravityReading } from '../schemas/events.ts';
import { type CountCommits, countCommits } from '../workspace/attempt-commits-git.ts';
import { runGit } from '../workspace/git.ts';
import { attemptSettings, writeAttemptSettings } from './attempt-settings.ts';
import { resumeArgs } from './claude-command.ts';
import {
  type ClaudeAttemptPlan,
  claudeBrewerRunner,
  clearOutDocFile,
  type OutDocRead,
  readOutDocFile,
  setUpFor,
} from './claude-runner.ts';

export interface InteractiveRunnerDeps {
  /** The `claude` program to start. */
  claude: string;
  plan: (attempt: AttemptStart) => Promise<ClaudeAttemptPlan>;
  /**
   * The process runner a resumed session's setup runs through before claude opens: the check
   * sandbox, network kept (ADR 0158, ADR 0163).
   */
  setup?: ExecProcess;
  /** The headless runner of an attempt that starts fresh, given its plan. */
  headless: (plan: (attempt: AttemptStart) => Promise<ClaudeAttemptPlan>) => BrewerRunner;
  /** Runs `program` in the foreground with the terminal's stdio; its exit code. */
  foreground: (
    program: string,
    args: readonly string[],
    cwd: string,
    env: Readonly<Record<string, string>>,
  ) => Promise<number>;
  /** The variables a terminal program reads to draw itself, which claude gets besides the brewer's. */
  terminalEnv: Readonly<Record<string, string>>;
  /** How the platform reads a variable's name: in any case on Windows. */
  platform: NodeJS.Platform;
  files: {
    writeSettings: (file: string, settings: AttemptSettings) => void;
    /** Reads the out doc only inside `root`, the worktree. */
    readOutDoc: (file: string, maxBytes: number, root: string) => OutDocRead;
    /** Removes the out doc a run before left, only inside `root` (ADR 0118). */
    clearOutDoc: (file: string, root: string) => void;
  };
  /** The commits on the attempt's branch in its clone after the limits' `commitsSince`. */
  commits: CountCommits;
  now: () => Date;
  /** Writes a line to the terminal, before claude has it. */
  say: (line: string) => void;
}

/** As the headless runner reads it: the out doc's text reaches the event log (ADR 0028). */
const MAX_OUT_DOC_BYTES = 1024 * 1024;

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** What the runner saw of a session the engineer ran: its exit, its out doc and its commits. */
const factsOf = (exit: ProcessExit, out: OutDocRead | undefined): AttemptFacts => ({
  exit,
  outDoc: out?.kind === 'text' ? out.text : undefined,
  outDocUnread: out?.kind === 'unread' ? out.reason : undefined,
  denials: 0,
  deniedTools: [],
  turns: 0,
});

export function interactiveBrewerRunnerWith(deps: InteractiveRunnerDeps): BrewerRunner {
  // The open sessions, and the headless runners of the fresh attempts, by attempt key.
  const open = new Set<string>();
  const headless = new Map<string, BrewerRunner>();

  const start = (attempt: AttemptStart) => {
    const { ref, limits } = attempt;
    const key = attemptKey.encode(ref);
    // A stop before a fresh attempt's run exists reaches it once it does.
    let stopped = false;
    let fresh: { stop(): void } | undefined;
    const unstartable = (error: unknown): AttemptEnd => {
      const exit = { kind: 'unstartable', reason: messageOf(error) } as const;
      return { ending: settleAttempt(factsOf(exit, undefined), limits) };
    };

    const run = async (): Promise<AttemptEnd> => {
      let plan: ClaudeAttemptPlan;
      let args: string[];
      try {
        plan = await deps.plan(attempt);
        if (plan.call.session.kind !== 'resume') {
          const planned = plan;
          const runner = deps.headless(async () => planned);
          headless.set(key, runner);
          const running = runner.start(attempt);
          fresh = running;
          if (stopped) running.stop();
          return await running.ended;
        }
        deps.files.writeSettings(plan.settingsFile, attemptSettings(plan.permissions));
        // Read by the out doc this session writes, never one the run before left (ADR 0118).
        deps.files.clearOutDoc(resolve(plan.cwd, limits.outDoc.file), plan.cwd);
        const { model, effort, tools, session } = plan.call;
        args = resumeArgs({
          model,
          effort,
          settingsFile: plan.settingsFile,
          tools,
          sessionId: session.id,
        });
      } catch (error) {
        return unstartable(error);
      }
      // The repository's setup first: the driver may have added the worktree again, without its
      // install (ADR 0163). The session is open meanwhile, so its lease is renewed.
      const before: GravityReading[] = [];
      if (plan.setup !== undefined) {
        open.add(key);
        try {
          const signal = new AbortController().signal;
          before.push(await setUpFor(plan.setup, plan.cwd, deps.setup, { now: deps.now, signal }));
        } finally {
          open.delete(key);
        }
        if (!before.every(passed)) return { ending: settleReadings(before), readings: before };
      }
      const readings = before.length === 0 ? {} : { readings: before };
      const label = `${ref.batchId} ${ref.stepId}#${ref.attempt}`;
      const what = `finish the step, have the session write ${limits.outDoc.file} as the brewer's instructions say, then exit claude; the batch goes on from its next step`;
      deps.say(
        `foedrum resume: opening session ${plan.call.session.id} of ${label} in ${plan.cwd}: ${what}`,
      );
      // The terminal's own variables under the attempt's environment (ADR 0109's forced variables
      // included), by name as the platform reads it, as for a finished attempt (ADR 0126).
      const env = buildBrewerEnv({
        base: deps.terminalEnv,
        brewer: Object.fromEntries(
          Object.entries(plan.env).flatMap(([name, value]) =>
            value === undefined ? [] : [[name, value]],
          ),
        ),
        forced: {},
        platform: deps.platform,
      });
      open.add(key);
      let code: number;
      try {
        code = await deps.foreground(deps.claude, args, plan.cwd, env);
      } catch (error) {
        return { ...unstartable(error), ...readings };
      } finally {
        open.delete(key);
      }
      const out = deps.files.readOutDoc(
        resolve(plan.cwd, limits.outDoc.file),
        MAX_OUT_DOC_BYTES,
        plan.cwd,
      );
      const facts = factsOf({ kind: 'exited', code }, out);
      // Counted on the attempt's branch in the clone, as for every run (ADR 0074).
      const since = limits.commitsSince;
      if (since !== undefined) {
        facts.commits =
          plan.commits === undefined
            ? { kind: 'uncounted', reason: 'the plan names no clone to count them in' }
            : await deps
                .commits(
                  plan.commits.clone,
                  plan.commits.branch,
                  since,
                  new AbortController().signal,
                )
                .catch(
                  (error: unknown) => ({ kind: 'uncounted', reason: messageOf(error) }) as const,
                );
      }
      const outDoc = facts.outDoc === undefined ? {} : { outDoc: facts.outDoc };
      return { ending: settleAttempt(facts, limits), ...outDoc, ...readings };
    };

    const ended = run().finally(() => headless.delete(key));
    return {
      ended,
      // The engineer's session is theirs to end: a stop reaches only a headless run (ADR 0127).
      stop: () => {
        stopped = true;
        fresh?.stop();
      },
    };
  };

  return {
    start,
    // An open session always progresses: its lease is renewed, and no stall limit judges a human.
    progress: (ref) => {
      const key = attemptKey.encode(ref);
      if (open.has(key)) return { lastProgressAt: deps.now(), turnsWithoutProgress: 0 };
      return headless.get(key)?.progress(ref);
    },
  };
}

/** The runner on the real machine: files, git and the headless runner of a fresh attempt. */
export function interactiveBrewerRunner(
  options: Pick<
    InteractiveRunnerDeps,
    'claude' | 'plan' | 'foreground' | 'terminalEnv' | 'platform' | 'say'
  > & {
    /** The process runner every attempt's setup runs through (ADR 0158, ADR 0163). */
    setup: ExecProcess;
  },
): BrewerRunner {
  const { setup } = options;
  return interactiveBrewerRunnerWith({
    ...options,
    headless: (plan) => claudeBrewerRunner({ claude: options.claude, plan, setup }),
    files: {
      writeSettings: writeAttemptSettings,
      readOutDoc: readOutDocFile,
      clearOutDoc: clearOutDocFile,
    },
    commits: countCommits(runGit),
    now: () => new Date(),
  });
}
