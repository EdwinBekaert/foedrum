// A scripted brewer runner for engine tests (ADR 0003): each attempt plays the next behaviour
// scripted for its step. What a settled attempt did goes through the real settleAttempt, so the
// tests exercise the same rules the real runner uses.

import { attemptKey } from '../../src/engine/attempt-key.ts';
import {
  type AttemptEnd,
  type AttemptFacts,
  type AttemptStart,
  type BrewerRunner,
  noteDenial,
  type RunningAttempt,
  settleAttempt,
} from '../../src/engine/brewer-runner.ts';
import type { AttemptProgress } from '../../src/engine/supervisor.ts';
import type { BlockerKind } from '../../src/schemas/out-doc.ts';
import type { Question } from '../../src/schemas/step-outcome.ts';

export type Behaviour =
  /** The process ends at once with these facts. */
  | { kind: 'settle'; facts: AttemptFacts }
  /** The process runs, reporting `progress`, until the engine stops it. */
  | { kind: 'hang'; progress: AttemptProgress }
  /** The process died with the runner that ran it: it never ends, and nothing reports it. */
  | { kind: 'lost' };

/** An out doc with this frontmatter. */
export const outDoc = (frontmatter: Record<string, unknown>): string =>
  `---\n${JSON.stringify(frontmatter, null, 2)}\n---\nThe brewer's notes.\n`;

/** A process that ends at once: a clean exit with `doc`, unless `more` says otherwise. */
const settle = (doc: string | undefined, more: Partial<AttemptFacts> = {}): Behaviour => ({
  kind: 'settle',
  facts: {
    exit: { kind: 'exited', code: 0 },
    outDoc: doc,
    denials: 0,
    deniedTools: [],
    turns: 12,
    ...more,
  },
});

export const question: Question = {
  q: 'Which database should the cache use?',
  options: ['sqlite', 'redis'],
  recommended: 'sqlite',
  whyBlocking: 'The two need different migrations',
};

/** The behaviours a scripted attempt can have (#11). */
export const behave = {
  succeed: (summary = 'Done'): Behaviour => settle(outDoc({ status: 'done', summary })),
  /** A retryable failure is reported in the out doc; a non-retryable one never starts. */
  fail: (retryable: boolean): Behaviour =>
    retryable
      ? settle(outDoc({ status: 'failed', summary: 'The migration does not apply' }))
      : settle(undefined, {
          exit: { kind: 'unstartable', reason: 'claude was not found on PATH' },
          turns: 0,
        }),
  hang: (progress: AttemptProgress): Behaviour => ({ kind: 'hang', progress }),
  /** The brewer process dies mid-step, after writing half an out doc. */
  crash: (): Behaviour =>
    settle('---\n{ "status": "do', { exit: { kind: 'killed', signal: 'SIGSEGV' }, turns: 7 }),
  lost: (): Behaviour => ({ kind: 'lost' }),
  /** The stream is not stream-json, whatever the out doc says. */
  garbage: (): Behaviour =>
    settle(outDoc({ status: 'done', summary: 'Done' }), { garbage: '\u0000\u0007 Abort trap' }),
  missingOutDoc: (): Behaviour => settle(undefined),
  invalidOutDoc: (): Behaviour => settle(outDoc({ status: 'finished', summary: 'Done' })),
  /** The runner stopped the brewer when it went past `maxTurns`. */
  exceedBudget: (turns: number): Behaviour =>
    settle(undefined, { exit: { kind: 'stopped' }, turns }),
  needInput: (questions: readonly Question[] = [question]): Behaviour =>
    settle(outDoc({ status: 'needs_input', summary: 'Needs a decision', questions })),
  blocked: (blockerKind: BlockerKind, summary = 'Blocked'): Behaviour =>
    settle(outDoc({ status: 'blocked', summary, blockerKind })),
  /** The runner stopped the brewer when its permission denials reached `maxDenials`. */
  denialStorm: (tools: readonly string[]): Behaviour => {
    const denials = tools.reduce(noteDenial, { denials: 0, deniedTools: [] });
    return settle(undefined, { exit: { kind: 'stopped' }, ...denials, turns: tools.length });
  },
};

export interface FakeBrewerRunner extends BrewerRunner {
  /** Every attempt started, in order. */
  readonly started: AttemptStart[];
  /** The attempts stopped by the engine, by attempt key. */
  readonly stopped: string[];
}

/**
 * A runner whose attempts at each step play `scripts[stepId]` in turn, or what `scripts` returns
 * for the attempt when it is a function.
 */
export const fakeBrewerRunner = (
  scripts:
    | Readonly<Record<string, readonly Behaviour[]>>
    | ((attempt: AttemptStart) => Behaviour | undefined),
): FakeBrewerRunner => {
  const queues = new Map(
    typeof scripts === 'function'
      ? []
      : Object.entries(scripts).map(([stepId, list]) => [stepId, [...list]]),
  );
  const running = new Map<string, AttemptProgress>();
  const started: AttemptStart[] = [];
  const stopped: string[] = [];

  const start = (attempt: AttemptStart): RunningAttempt => {
    started.push(attempt);
    const key = attemptKey.encode(attempt.ref);
    const behaviour =
      typeof scripts === 'function' ? scripts(attempt) : queues.get(attempt.ref.stepId)?.shift();
    if (behaviour === undefined) throw new Error(`No behaviour scripted for ${key}`);
    const end = (facts: AttemptFacts): AttemptEnd => ({
      ending: settleAttempt(facts, attempt.limits),
    });
    switch (behaviour.kind) {
      case 'settle':
        return { ended: Promise.resolve().then(() => end(behaviour.facts)), stop: () => {} };
      case 'hang': {
        running.set(key, behaviour.progress);
        let stop = (): void => {};
        const ended = new Promise<AttemptEnd>((resolve, reject) => {
          stop = () => {
            if (!running.delete(key)) return;
            stopped.push(key);
            const facts: AttemptFacts = {
              exit: { kind: 'stopped' },
              outDoc: undefined,
              denials: 0,
              deniedTools: [],
              turns: behaviour.progress.turnsWithoutProgress,
            };
            try {
              resolve(end(facts));
            } catch (error) {
              reject(error);
            }
          };
        });
        return { ended, stop };
      }
      case 'lost':
        return { ended: new Promise<AttemptEnd>(() => {}), stop: () => {} };
      default: {
        const unhandled: never = behaviour;
        throw new Error(`Unhandled behaviour ${JSON.stringify(unhandled)}`);
      }
    }
  };

  return {
    started,
    stopped,
    start,
    progress: (ref) => running.get(attemptKey.encode(ref)),
  };
};
