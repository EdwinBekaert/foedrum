// Reading claude's stream-json (ADR 0042, ADR 0046, ADR 0047): one stdout line at a time, the
// init check first, then the facts settleAttempt decides on and the progress the stall watchdog
// reads. Pure: the runner hands it each line with the time it came.

import type { AttemptFacts } from '../engine/brewer-runner.ts';
import type { AttemptProgress } from '../engine/supervisor.ts';
import type { Usage } from '../schemas/events.ts';
import type { AskedSession, SessionFacts } from './claude-init.ts';

/** What the runner asked for, and when it stops the attempt itself. */
export interface StreamAsk extends AskedSession {
  /** Stops the attempt at the denial that reaches it. */
  maxDenials?: number | undefined;
}

/** What the stream showed, for settleAttempt. */
export type StreamFacts = Pick<
  AttemptFacts,
  'environment' | 'streamError' | 'garbage' | 'denials' | 'deniedTools' | 'turns'
> & {
  /** The session claude set up, once its init matched what was asked. */
  session?: SessionFacts;
  /** The result's tokens. */
  usage?: Usage;
  /** How many lines came, empty ones included. */
  lines: number;
};

export interface StreamReader {
  /** Reads one stdout line that came at `now`; `stop` when the runner must stop the attempt. */
  read(line: string, now: Date): 'go' | 'stop';
  facts(): StreamFacts;
  /** For the stall watchdog: when the brewer last wrote a file or committed, and turns since. */
  progress(): AttemptProgress;
}

/** A reader for one attempt's stream, which started at `startedAt`. */
export function readClaudeStream(_asked: StreamAsk, _startedAt: Date): StreamReader {
  throw new Error('not implemented');
}
