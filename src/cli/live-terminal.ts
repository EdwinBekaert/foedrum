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
