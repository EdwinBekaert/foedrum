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

/** What the console sends claude and foedrum alike: claude's while it has the terminal. */
const CONSOLE_SIGNALS: readonly NodeJS.Signals[] = ['SIGINT', 'SIGBREAK'];

/** The gate over `write`, the terminal, and `listen`, the process's signals. */
export const foregroundGate = (
  write: (line: string) => void,
  listen: ListenForSignal,
): ForegroundGate => {
  let open = false;
  const waiting: string[] = [];
  return {
    out: (line) => {
      if (open) waiting.push(line);
      else write(line);
    },
    listen: (name, handler) =>
      listen(name, () => {
        if (!open || !CONSOLE_SIGNALS.includes(name)) handler();
      }),
    foreground: async (program) => {
      open = true;
      try {
        return await program();
      } finally {
        open = false;
        for (const line of waiting.splice(0)) write(line);
      }
    },
  };
};
