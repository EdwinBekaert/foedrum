// A fake terminal for the tests of `foedrum brew`'s live line (ADR 0174), with what those tests read
// off a line it drew.

import assert from 'node:assert/strict';
import type { LiveTerminal } from '../../src/cli/serve.ts';

export const SPINNER = ['|', '/', '-', '\\'];

/** Settles once `signal` aborts: how a fake `wait` holds a wait the brew runs beside a call. */
export const aborted = (signal: AbortSignal): Promise<void> =>
  new Promise((done) => {
    if (signal.aborted) done();
    else signal.addEventListener('abort', () => done(), { once: true });
  });

/**
 * A terminal over a fake screen (ADR 0174): it keeps what the live line shows now, every call and
 * every lasting line in order, and the lasting lines printed while the live line was on screen.
 */
export const fakeScreen = (width: number | 'unknown', marks: readonly string[] = SPINNER) => {
  let columns = width === 'unknown' ? undefined : width;
  let drawn: string | undefined;
  const events: string[] = [];
  const resizers = new Set<() => void>();
  const printedOver: string[] = [];
  const terminal: LiveTerminal = {
    marks,
    columns: () => columns,
    onResize: (handler) => {
      resizers.add(handler);
      return () => {
        resizers.delete(handler);
      };
    },
    clear: () => {
      events.push('clear');
      drawn = undefined;
    },
    rewrite: (text) => {
      events.push(`rewrite: ${text}`);
      drawn = text;
    },
  };
  /** The live lines drawn, in order. */
  const rewrites = (): string[] =>
    events.filter((event) => event.startsWith('rewrite: ')).map((event) => event.slice(9));
  return {
    terminal,
    events,
    resizers,
    printedOver,
    rewrites,
    /** What the live line shows now. */
    drawn: () => drawn,
    /** The shell's `out`: a lasting line. */
    print: (line: string): void => {
      if (drawn !== undefined) printedOver.push(line);
      events.push(`out: ${line}`);
    },
    resize: (to: number | undefined): void => {
      columns = to;
      for (const handler of [...resizers]) handler();
    },
    /** The live lines drawn, each without its spinner and the batch's time (ADR 0179). */
    texts: (): string[] =>
      rewrites().map((text) => {
        assert.ok(SPINNER.includes(text[0] ?? ''), `a spinner starts ${JSON.stringify(text)}`);
        const batchTime = BATCH_TIME.exec(text.slice(2));
        assert.ok(batchTime, `the batch's time leads ${JSON.stringify(text)}`);
        return text.slice(2 + batchTime[0].length);
      }),
    /** The batch's time, without its words, on each live line drawn. */
    batchTimes: (): string[] =>
      rewrites().map((text) => BATCH_TIME.exec(text.slice(2))?.[1] ?? `none in ${text}`),
  };
};

/**
 * The batch's time that leads a live line after its spinner, with the words that say what it
 * measures and the ` / ` after it (ADR 0326): `ordered 5m 3s ago`, or `brew started 3s ago` for a
 * batch with no recorded order time.
 */
const BATCH_TIME = /^(?:ordered|brew started) ((?:\d+m )?\d+s) ago \/ /;

/** The line without its elapsed time, which depends on when each redraw came. */
export const withoutTime = (text: string): string => text.replace(/ \/ (\d+m )?\d+s(?= \/|$)/, '');
