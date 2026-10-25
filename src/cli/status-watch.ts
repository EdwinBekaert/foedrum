// `foedrum status --watch` (ADR 0188): a board of the live batches, redrawn in place about once a
// second on a terminal, read from the Brewery's store as `foedrum status` reads it.

import type { State } from '../engine/fold.ts';
import type { BoardTerminal } from './live-terminal.ts';
import type { CliResult } from './run.ts';

/** What the board needs from the machine. */
export interface WatchShell {
  /** The terminal the board is drawn on; none where `status --watch` is refused (ADR 0188). */
  terminal: BoardTerminal | undefined;
  /** The Brewery's store, read and folded afresh: no lease, no git, no kept branches. */
  state: () => State;
  /** Aborts on Ctrl+C or a stop. */
  signal: AbortSignal;
  clock: () => Date;
  /** Waits `ms`, or less once `signal` aborts. */
  wait: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** Draws the board until `shell.signal` aborts, exit code 0; refuses, exit code 1, off a terminal. */
export const watchStatus = async (_shell: WatchShell): Promise<CliResult> => {
  throw new Error('not implemented');
};
