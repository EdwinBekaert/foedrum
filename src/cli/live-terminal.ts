// The terminal `foedrum brew` keeps a live line on (ADR 0174): Node's `tty.WriteStream` behind
// `LiveTerminal`, given only when standard output is a TTY, `TERM` is not `dumb` and `CI` is not set.

import type { LiveTerminal } from './serve.ts';

/** The part of `tty.WriteStream` the live line uses. */
export interface TerminalStream {
  isTTY?: boolean | undefined;
  columns?: number | undefined;
  on(event: 'resize', handler: () => void): unknown;
  off(event: 'resize', handler: () => void): unknown;
  cursorTo(x: number): boolean;
  clearLine(direction: -1 | 0 | 1): boolean;
  write(text: string): boolean;
}

/** The live terminal over `stream` when the rule of ADR 0174 holds in `env`, else none. */
export const liveTerminal = (
  _stream: TerminalStream,
  _env: Readonly<Record<string, string | undefined>>,
): LiveTerminal | undefined => {
  throw new Error('not implemented');
};
