// The live line of the commands that drive batches on a terminal (ADR 0174, ADR 0346): what the
// batches' attempts do, fitted to the terminal and redrawn each second, with a mark that turns on a
// timer of its own. `foedrum brew` and `foedrum serve` draw it alike (ADR 0427).

import { type AttemptRef, attemptKey } from '../engine/attempt-key.ts';
import type { Batch } from '../engine/fold.ts';
import type { AttemptProgress } from '../engine/supervisor.ts';
import type { LiveTerminal, ServeShell } from './serve.ts';

/** `ms` as whole seconds, minutes from one and hours from one: `30s`, `1m 0s`, `17h 22m`. */
export const elapsed = (ms: number): string => {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60
    ? `${minutes}m ${seconds % 60}s`
    : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};

/** An attempt of a batch that runs now: named `<step> #<n>`, and the ref the driver reports it by. */
export interface Running {
  label: string;
  ref: AttemptRef;
}

/** The attempts of `batch` that run now. */
export const runningAttempts = (batch: Batch): Running[] =>
  [...batch.steps.values()].flatMap(({ id, attempts }) =>
    [...attempts.values()]
      .filter((attempt) => attempt.phase === 'started' && attempt.abandoned !== true)
      .map(({ attempt }) => ({
        label: `${id} #${attempt}`,
        ref: { batchId: batch.id, stepId: id, attempt },
      })),
  );

/** How often the moving mark turns, as `gh`'s does (ADR 0346). */
const MARK_MS = 120;
/** How often the live line's words are read again and redrawn, apart from the tick. */
const REDRAW_MS = 1000;
/** What holds the mark's column while a line is fitted to the terminal. */
const MARK_ROOM = '|';
/** The longest a tool's name is shown, before it is escaped. */
const TOOL_NAME_MAX = 64;
/** The width of a terminal that does not say. */
const UNKNOWN_COLUMNS = 80;

/** What the live line shows of one running attempt, in the order of ADR 0174, one part each. */
const attemptParts = (
  label: string,
  ms: number,
  progress: AttemptProgress | undefined,
): string[] => {
  const parts = [label, elapsed(ms)];
  if (progress?.settingUp === true) {
    parts.push('setup');
  } else {
    if (progress?.turn !== undefined) parts.push(`turn ${progress.turn}`);
    const tool = progress?.lastTool;
    if (tool !== undefined) {
      const name = tool.name.slice(0, TOOL_NAME_MAX);
      parts.push(tool.word === undefined ? name : `${name} ${tool.word}`);
    }
    if (progress?.denied === true) parts.push('denied');
  }
  return parts;
};

/** `line` in ASCII only: every UTF-16 unit outside U+0020 to U+007E as a `\uXXXX` escape. */
const ascii = (line: string): string =>
  line.replace(/[^ -~]/g, (unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`);

/**
 * `line` in ASCII only, cut from the end to one character less than the terminal's width
 * (ADR 0174, ADR 0179, ADR 0188).
 */
export const fit = (line: string, columns: number | undefined): string =>
  ascii(line).slice(0, Math.max(0, (columns ?? UNKNOWN_COLUMNS) - 1));

/** What the live line says of one batch: its time, and its attempts, each in its parts. */
interface BatchParts {
  time: string;
  attempts: readonly (readonly string[])[];
}

/**
 * The live line: a column for the mark, then each batch's time with its words (ADR 0326) and its
 * attempts, fitted to the terminal. Side by side, attempts give up their last parts together
 * before any of them is cut off (ADR 0346), those of every batch of the line (ADR 0427).
 */
const liveLine = (batches: readonly BatchParts[], columns: number | undefined) => {
  const joined = (keep: number): string =>
    `${MARK_ROOM} ${batches
      .map(
        ({ time, attempts }) =>
          `${time} / ${attempts.map((parts) => parts.slice(0, keep).join(' / ')).join(' ; ')}`,
      )
      .join(' ; ')}`;
  const attempts = batches.flatMap((batch) => batch.attempts);
  let keep = Math.max(...attempts.map((parts) => parts.length));
  while (
    attempts.length > 1 &&
    keep > 1 &&
    ascii(joined(keep)).length > (columns ?? UNKNOWN_COLUMNS) - 1
  ) {
    keep--;
  }
  return fit(joined(keep), columns);
};

/**
 * The columns a line is fitted to on `terminal`: its width, less one where a mark is not ASCII. A
 * braille frame can take two columns, as in Windows Terminal drawing it from a fallback font, and a
 * line that filled the width would wrap, so each redraw would land on a new row (ADR 0453).
 */
const room = (terminal: LiveTerminal): number | undefined => {
  const columns = terminal.columns();
  if (!terminal.marks.some((mark) => /[^ -~]/.test(mark))) return columns;
  return (columns ?? UNKNOWN_COLUMNS) - 1;
};

/** What the live line shows of one batch it reads. */
export interface LiveBatch {
  /** What the batch's time counts from and says (ADR 0179, ADR 0326). */
  since: { words: string; from: number };
  /** The attempts of the batch that run now. */
  running: Running[];
  /** What the driver reports of one of them. */
  progressOf: (ref: AttemptRef) => AttemptProgress | undefined;
}

/** What the live line needs: the shell's, and the batches it shows each time it is drawn. */
interface LiveLineOptions extends Pick<ServeShell, 'clock' | 'wait' | 'signal'> {
  /** The terminal it is drawn on; none, and nothing is drawn. */
  terminal: LiveTerminal | undefined;
  /** The batches the line shows now: one part each, and none while nothing is driven (ADR 0427). */
  batches: () => LiveBatch[];
}

/** A turn of the event loop, so a call that needs no time ends before the live line waits beside it. */
const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** The live line of `options.terminal`, drawn from `start` to `stop`; with no terminal, nothing is. */
export const createLiveLine = ({ terminal, signal, clock, wait, batches }: LiveLineOptions) => {
  // When this driver first saw each running attempt run, and what the command does while a call
  // takes time, which its words say in place of the attempts'.
  const seenAt = new Map<string, number>();
  let doing: string | undefined;
  let frame = 0;
  // The line last fitted to the terminal, with the column its mark goes in, and whether it shows.
  let fitted: string | undefined;
  let onScreen = false;
  const clearLive = (): void => {
    if (!onScreen) return;
    terminal?.clear();
    onScreen = false;
  };
  /**
   * When this driver first saw the attempt run: `at` when it sees it now for the first time. Kept by
   * the attempt's ref, not its label, which two batches of a serve can share (ADR 0427).
   */
  const firstSeen = ({ ref }: Running, at: number): number => {
    const key = attemptKey.encode(ref);
    const first = seenAt.get(key);
    if (first !== undefined) return first;
    seenAt.set(key, at);
    return at;
  };
  const noticed = (attempts: readonly Running[], at: number): void => {
    for (const attempt of attempts) firstSeen(attempt, at);
  };
  /** The line last fitted, with the mark's frame now in its first column, if it has one. */
  const show = (): void => {
    if (terminal === undefined || fitted === undefined) return;
    const mark = terminal.marks[frame % terminal.marks.length] ?? MARK_ROOM;
    terminal.rewrite(fitted.replace(/^./, () => mark));
    onScreen = true;
  };
  /**
   * The live line reads the store and writes to a terminal, and is for display: one that cannot be
   * drawn changes no call, no exit code and no effect (ADR 0346). What read the store for the
   * command's own work fails there and says so.
   */
  const drawn = (): void => {
    if (terminal === undefined) return;
    const at = clock().getTime();
    const held = batches();
    // An attempt that no longer runs is forgotten, so a serve that runs for days keeps no more
    // than the attempts that run now (ADR 0427).
    const running = new Set(
      held.flatMap((batch) => batch.running.map(({ ref }) => attemptKey.encode(ref))),
    );
    for (const key of seenAt.keys()) if (!running.has(key)) seenAt.delete(key);
    const shown = held.map(({ since, running, progressOf }) => {
      noticed(running, at);
      // What it does now, else the attempts that run now, else that nothing runs between two steps.
      const attempts =
        doing !== undefined
          ? [[doing]]
          : running.length === 0
            ? [['between steps']]
            : running.map((attempt) =>
                attemptParts(attempt.label, at - firstSeen(attempt, at), progressOf(attempt.ref)),
              );
      return { time: `${since.words} ${elapsed(Math.max(0, at - since.from))} ago`, attempts };
    });
    // With no batch to drive, it says that it waits for one (ADR 0427).
    fitted =
      shown.length === 0
        ? fit(`${MARK_ROOM} waiting for work`, room(terminal))
        : liveLine(shown, room(terminal));
    show();
  };
  const draw = (): void => {
    try {
      drawn();
    } catch {}
  };
  /** Calls `step` every `ms` on the shell's wait until `until` aborts, a turn of the loop before each. */
  const beat = async (ms: number, until: AbortSignal, step: () => void): Promise<void> => {
    while (!until.aborted) {
      await turn();
      if (until.aborted) break;
      await wait(ms, until);
      if (!until.aborted) step();
    }
  };
  // The mark turns on a timer of its own, writing the fitted line again: no state is read and no
  // tick is moved for it (ADR 0346).
  const marksEnd = new AbortController();
  const turning = AbortSignal.any([signal, marksEnd.signal]);
  let stopResize: (() => void) | undefined;
  let marks: Promise<void> | undefined;
  return {
    firstSeen,
    noticed,
    /** Says what the command does while a call takes time, and draws it. */
    doing: (words: string): void => {
      doing = words;
      draw();
    },
    /** Starts the mark's timer and the redraw on a resize. */
    start: (): void => {
      if (terminal === undefined) return;
      stopResize = terminal.onResize(draw);
      marks = beat(MARK_MS, turning, () => {
        frame++;
        try {
          show();
        } catch {}
      });
    },
    /** Stops them and takes the line off the screen, so the last lines on screen are lasting ones. */
    stop: async (): Promise<void> => {
      stopResize?.();
      stopResize = undefined;
      marksEnd.abort();
      await marks;
      clearLive();
    },
    /** Prints a lasting line over the live line: clears it, prints, and draws it again. */
    over: (print: () => void): void => {
      const wasOnScreen = onScreen;
      clearLive();
      print();
      if (wasOnScreen) draw();
    },
    /**
     * Awaits `call` with the live line moving beside it: `words` say what it does (the driver's own
     * `doing` may say more), redrawn each second on the shell's wait, which a call that takes no
     * time never reaches. Plain, it only awaits.
     */
    lively: async <T>(words: string | undefined, call: () => Promise<T>): Promise<T> => {
      if (terminal === undefined) return call();
      doing = words;
      const stop = new AbortController();
      const redraws = AbortSignal.any([signal, stop.signal]);
      if (words !== undefined || !onScreen) draw();
      const moving = beat(REDRAW_MS, redraws, draw);
      try {
        return await call();
      } finally {
        stop.abort();
        await moving;
        doing = undefined;
      }
    },
    /**
     * Until the next tick, `intervalMs` away: plain, one wait; on a terminal, a redraw each second
     * (ADR 0174), counted rather than read off the clock, so a clock set back cannot hold the tick off.
     */
    pause: async (intervalMs: number): Promise<void> => {
      if (terminal === undefined) return wait(intervalMs, signal);
      const redraws = Math.max(1, Math.ceil(intervalMs / REDRAW_MS));
      for (let each = 0; each < redraws && !signal.aborted; each++) {
        draw();
        await wait(Math.min(REDRAW_MS, intervalMs), signal);
      }
    },
  };
};
