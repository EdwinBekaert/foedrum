// The terminal while `foedrum resume` hands it to claude (ADR 0127): the driver's lines wait until
// claude gives it back, and the console's own signals (Ctrl+C, Ctrl+Break), which reach claude
// and foedrum alike, are claude's meanwhile. A kill or a closed terminal still stops foedrum.

import type { ListenForSignal } from '../platform/processes.ts';

export interface ForegroundGate {
  /** Writes a line now, or once claude has given the terminal back. */
  out: (line: string) => void;
  /** Listens for a stop signal, but for the console's own while claude has the terminal. */
  listen: ListenForSignal;
  /** Runs `program`, which has the terminal until it settles. */
  foreground: <T>(program: () => Promise<T>) => Promise<T>;
}

/** The gate over `write`, the terminal, and `listen`, the process's signals. */
export const foregroundGate = (
  _write: (line: string) => void,
  _listen: ListenForSignal,
): ForegroundGate => {
  throw new Error('not implemented');
};
