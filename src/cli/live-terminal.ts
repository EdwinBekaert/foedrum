// The terminal `foedrum brew` keeps a live line on (ADR 0174): Node's `tty.WriteStream` behind
// `LiveTerminal`, given only when standard output is a TTY, `TERM` is not `dumb` and `CI` is not set.

import type { LiveTerminal } from './serve.ts';

/** The part of `tty.WriteStream` the live line and the board use. */
export interface TerminalStream {
  isTTY?: boolean | undefined;
  columns?: number | undefined;
  rows?: number | undefined;
  on(event: 'resize', handler: () => void): unknown;
  off(event: 'resize', handler: () => void): unknown;
  cursorTo(x: number): boolean;
  moveCursor(dx: number, dy: number): boolean;
  clearLine(direction: -1 | 0 | 1): boolean;
  clearScreenDown(): boolean;
  write(text: string): boolean;
}

/** The terminal `foedrum status --watch` keeps a board of lines on (ADR 0188). */
export interface BoardTerminal {
  /** The terminal's width in characters, when it is known. */
  columns: () => number | undefined;
  /** The terminal's height in lines, when it is known. */
  rows: () => number | undefined;
  /** Calls `handler` when the terminal is resized; the returned function stops it. */
  onResize: (handler: () => void) => () => void;
  /** Draws `lines` as the board: as new lines the first time, then in place over the last board. */
  redraw: (lines: readonly string[]) => void;
  /** Ends the board: leaves the last one on screen and moves to a new line. */
  finish: () => void;
}

/** The board terminal over `stream` when the rule of ADR 0174 holds in `env`, else none. */
export const boardTerminal = (
  _stream: TerminalStream,
  _env: Readonly<Record<string, string | undefined>>,
): BoardTerminal | undefined => {
  throw new Error('not implemented');
};

/** The live terminal, and the way every lasting line reaches it. */
export interface StdoutTerminal extends LiveTerminal {
  /** Prints a lasting line: clears the live line, writes `line`, and draws the live line again. */
  print: (line: string) => void;
}

/** The live terminal over `stream` when the rule of ADR 0174 holds in `env`, else none. */
export const liveTerminal = (
  stream: TerminalStream,
  env: Readonly<Record<string, string | undefined>>,
): StdoutTerminal | undefined => {
  if (stream.isTTY !== true || env.TERM === 'dumb' || env.CI !== undefined) return undefined;
  // The live line on screen now, so a lasting line from anywhere can go over it.
  let shown: string | undefined;
  const clear = (): void => {
    stream.cursorTo(0);
    stream.clearLine(0);
    shown = undefined;
  };
  // Over the old line in place, then clear what is left to its right: never a blank frame
  // between two lines (ADR 0179).
  const rewrite = (text: string): void => {
    stream.cursorTo(0);
    stream.write(text);
    stream.clearLine(1);
    shown = text;
  };
  return {
    columns: () => stream.columns,
    onResize: (handler) => {
      stream.on('resize', handler);
      return () => {
        stream.off('resize', handler);
      };
    },
    clear,
    rewrite,
    print: (line) => {
      const live = shown;
      if (live !== undefined) clear();
      stream.write(`${line}\n`);
      if (live !== undefined) rewrite(live);
    },
  };
};
