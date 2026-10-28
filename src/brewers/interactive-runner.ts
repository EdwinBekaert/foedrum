// The brewer runner of `foedrum resume` on a running batch (ADR 0127) and of `foedrum brew` on a
// terminal (ADR 0222): an interactive step's attempt opens a new session, and with resume an attempt
// that resumes a session opens it, as the person's interactive `claude` in the foreground, with the
// attempt's settings, guards and environment; each ends by the out doc the session wrote, through
// settleAttempt as every run does. Every other attempt runs headless, as its driver would.

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
import { type ReadPaths, touchesChecked } from '../engine/plan-touches.ts';
import type { ExecProcess } from '../platform/processes.ts';
import type { AttemptSettings } from '../schemas/attempt-settings.ts';
import type { GravityReading } from '../schemas/events.ts';
import {
  type CountCommits,
  countCommits,
  type ScanCommits,
  scanAttemptCommits,
} from '../workspace/attempt-commits-git.ts';
import { runGit } from '../workspace/git.ts';
import { readPathsAt } from '../workspace/plan-paths-git.ts';
import { attemptSettings, writeAttemptSettings } from './attempt-settings.ts';
import { interactiveArgs, resumeArgs } from './claude-command.ts';
import {
  type ClaudeAttemptPlan,
  claudeBrewerRunner,
  clearOutDocFile,
  commitsOf,
  type OutDocRead,
  outDocBefore,
  readOutDocFile,
  restoreOutDocFile,
  scannedIfDone,
  setUpFor,
  writeSystemPromptFile,
} from './claude-runner.ts';

export interface InteractiveRunnerDeps {
  /** The `claude` program to start. */
  claude: string;
  /**
   * Whether an attempt that resumes a session opens it in the foreground: `foedrum resume`'s, by
   * default; `foedrum brew`'s runs it headless and opens only interactive steps (ADR 0222).
   */
  opensResumed?: boolean;
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
    /** Writes the attempt's system prompt file (ADR 0183). */
    writeSystemPrompt: (file: string, text: string) => void;
    /** Writes an interactive step's prompt file (ADR 0222). */
    writePrompt: (file: string, text: string) => void;
    /** Reads the out doc only inside `root`, the worktree. */
    readOutDoc: (file: string, maxBytes: number, root: string) => OutDocRead;
    /** Removes the out doc a run before left, only inside `root` (ADR 0118). */
    clearOutDoc: (file: string, root: string) => void;
    /** Puts back the copy of the out doc of a session that ran out of turns (ADR 0175). */
    restoreOutDoc: (file: string, root: string, copy: string) => void;
  };
  /** The commits on the attempt's branch in its clone after the limits' `commitsSince`. */
  commits: CountCommits;
  /**
   * Scans a done attempt's commits after the limits' `commitsSince` for secrets, as the push does
   * (ADR 0187).
   */
  scan: ScanCommits;
  /** Reads which paths of a done plan exist at a commit in a repository's clone (ADR 0233). */
  touches: ReadPaths;
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
    // A stop reaches the setup before a resumed session, which is the attempt's, not the
    // engineer's (ADR 0163).
    const settingUp = new AbortController();
    const unstartable = (error: unknown): AttemptEnd => {
      const exit = { kind: 'unstartable', reason: messageOf(error) } as const;
      return { ending: settleAttempt(factsOf(exit, undefined), limits) };
    };
    // As a headless run that was stopped: the engine stopped the attempt, so no session opens
    // for it, since nothing the person did there would be read (ADR 0222).
    const cancelled = (): AttemptEnd => ({
      ending: settleAttempt(factsOf({ kind: 'stopped' }, undefined), limits),
    });

    const run = async (): Promise<AttemptEnd> => {
      let plan: ClaudeAttemptPlan;
      let args: string[];
      try {
        plan = await deps.plan(attempt);
        // By the step: an interactive step's session opens; a resumed one only in resume's runner.
        const { interactive } = plan;
        const resumed = plan.call.session.kind === 'resume' && deps.opensResumed !== false;
        if (interactive === undefined && !resumed) {
          const planned = plan;
          const runner = deps.headless(async () => planned);
          headless.set(key, runner);
          const running = runner.start(attempt);
          fresh = running;
          if (stopped) running.stop();
          return await running.ended;
        }
        if (stopped) return cancelled();
        deps.files.writeSettings(plan.settingsFile, attemptSettings(plan.permissions));
        const { systemPrompt } = plan;
        if (systemPrompt !== undefined)
          deps.files.writeSystemPrompt(systemPrompt.file, systemPrompt.text);
        // The whole prompt, inputs in their nonce tags, which the first message points at.
        if (interactive !== undefined) deps.files.writePrompt(interactive.file, plan.prompt);
        // A new interactive session too: its worktree may hold the out doc of an attempt before.
        outDocBefore(deps.files, plan, limits.outDoc.file);
        const { model, effort, tools, session } = plan.call;
        const call = {
          model,
          effort,
          settingsFile: plan.settingsFile,
          tools,
          sessionId: session.id,
          appendSystemPromptFile: systemPrompt?.file,
        };
        args =
          interactive === undefined
            ? resumeArgs(call)
            : interactiveArgs({ ...call, firstMessage: interactive.firstMessage });
      } catch (error) {
        return unstartable(error);
      }
      // The repository's setup first: the driver may have added the worktree again, without its
      // install (ADR 0163). The session is open meanwhile, so its lease is renewed.
      const before: GravityReading[] = [];
      if (plan.setup !== undefined) {
        open.add(key);
        try {
          const signal = settingUp.signal;
          before.push(await setUpFor(plan.setup, plan.cwd, deps.setup, { now: deps.now, signal }));
        } finally {
          open.delete(key);
        }
        if (!before.every(passed)) return { ending: settleReadings(before), readings: before };
      }
      const readings = before.length === 0 ? {} : { readings: before };
      // A stop during a setup that passed all the same.
      if (stopped) return { ...cancelled(), ...readings };
      const label = `${ref.batchId} ${ref.stepId}#${ref.attempt}`;
      const doc = limits.outDoc.file;
      const [command, what] =
        plan.interactive === undefined
          ? [
              'resume',
              `finish the step, have the session write ${doc} as the brewer's instructions say`,
            ]
          : [
              'brew',
              `work the step through with the session, have it write ${doc} as the brewer's instructions say`,
            ];
      deps.say(
        `foedrum ${command}: opening session ${plan.call.session.id} of ${label} in ${plan.cwd}: ${what}, then exit claude; the batch goes on from its next step`,
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
      const commits = await commitsOf(
        deps.commits,
        plan,
        limits.commitsSince,
        new AbortController().signal,
      );
      if (commits !== undefined) facts.commits = commits;
      const outDoc = facts.outDoc === undefined ? {} : { outDoc: facts.outDoc };
      // Scanned for secrets on the attempt's branch, and a plan's paths read, as for every run
      // (ADR 0187, ADR 0233).
      const ending = await touchesChecked(
        deps.touches,
        await scannedIfDone(deps.scan, facts, limits, plan, new AbortController().signal),
        plan.touches,
      );
      return { ending, ...outDoc, ...readings };
    };

    const ended = run().finally(() => headless.delete(key));
    return {
      ended,
      // The engineer's session is theirs to end: a stop reaches only a headless run (ADR 0127),
      // the setup before a resumed session (ADR 0163), and an attempt whose session has not opened.
      stop: () => {
        stopped = true;
        fresh?.stop();
        settingUp.abort();
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

/**
 * The headless runner of a fresh attempt on the real machine, which runs the attempt's setup
 * through `setup` (ADR 0163).
 */
export const headlessRunner =
  (claude: string, setup: ExecProcess) =>
  (plan: (attempt: AttemptStart) => Promise<ClaudeAttemptPlan>): BrewerRunner =>
    claudeBrewerRunner({ claude, plan, setup });

/** The runner on the real machine: files, git and the headless runner of a fresh attempt. */
export function interactiveBrewerRunner(
  options: Pick<
    InteractiveRunnerDeps,
    'claude' | 'opensResumed' | 'plan' | 'foreground' | 'terminalEnv' | 'platform' | 'say'
  > & {
    /** The process runner every attempt's setup runs through (ADR 0158, ADR 0163). */
    setup: ExecProcess;
  },
): BrewerRunner {
  return interactiveBrewerRunnerWith({
    ...options,
    headless: headlessRunner(options.claude, options.setup),
    files: {
      writeSettings: writeAttemptSettings,
      writeSystemPrompt: writeSystemPromptFile,
      writePrompt: writeSystemPromptFile,
      readOutDoc: readOutDocFile,
      clearOutDoc: clearOutDocFile,
      restoreOutDoc: restoreOutDocFile,
    },
    commits: countCommits(runGit),
    scan: scanAttemptCommits(runGit),
    touches: readPathsAt(runGit),
    now: () => new Date(),
  });
}
