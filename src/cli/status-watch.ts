// `foedrum status --watch` (ADR 0188): a board of the live batches, redrawn in place about once a
// second on a terminal, read from the Brewery's store as `foedrum status` reads it.

import type { Batch, State } from '../engine/fold.ts';
import { elapsed, fit, runningAttempts } from './brew.ts';
import { columns } from './columns.ts';
import type { BoardTerminal } from './live-terminal.ts';
import type { CliResult } from './run.ts';
import { statusRow } from './status.ts';

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

/** How often the board is redrawn. */
const REDRAW_MS = 1000;

const refusal = 'foedrum status --watch needs a terminal; foedrum status prints the batches once';

/** The lanes a batch is live in: On Tap and Cancelled have ended. */
const isLive = ({ lane }: Batch): boolean => lane.kind !== 'on_tap' && lane.kind !== 'cancelled';

/** Draws the board until `shell.signal` aborts, exit code 0; refuses, exit code 1, off a terminal. */
export const watchStatus = async (shell: WatchShell): Promise<CliResult> => {
  const { terminal, state, signal, clock, wait } = shell;
  if (terminal === undefined) return { exitCode: 1, stdout: '', stderr: `${refusal}\n` };
  // When this board first saw each running attempt run, as `brew` counts `seenAt`.
  let seenAt = new Map<string, number>();
  const draw = (): void => {
    const folded = state();
    const at = clock().getTime();
    const batches = [...folded.batches.values()].filter(isLive);
    const seen = new Map<string, number>();
    // A batch's row, led by its time, and a line under it for each attempt that runs.
    const groups = batches.map((batch) => {
      const time =
        batch.orderedAt === undefined
          ? '-'
          : elapsed(Math.max(0, at - Date.parse(batch.orderedAt)));
      const attempts = (batch.lane.kind === 'brewing' ? runningAttempts(batch) : []).map(
        ({ label }) => {
          const key = `${batch.id}/${label}`;
          const first = seenAt.get(key) ?? at;
          seen.set(key, first);
          return `  ${label} / ${elapsed(Math.max(0, at - first))}`;
        },
      );
      return { row: [time, ...statusRow(folded, batch)], attempts };
    });
    seenAt = seen;
    const rows = columns(
      groups.map(({ row }) => row),
      '',
    );
    const header =
      batches.length === 0
        ? 'No live batches.'
        : `${batches.length} live ${batches.length === 1 ? 'batch' : 'batches'}`;
    const height = terminal.rows();
    // The header and the rows leave the last line of the terminal free; the attempts' lines go
    // before any row does, and a row that does not fit is told as a count.
    const room = height === undefined ? Number.POSITIVE_INFINITY : Math.max(1, height - 1) - 1;
    const withAttempts = groups.flatMap(({ attempts }, i) => [rows[i] ?? '', ...attempts]);
    let body = withAttempts;
    if (withAttempts.length > room) {
      body = rows;
      if (rows.length > room) {
        const kept = Math.max(0, room - 1);
        body = [...rows.slice(0, kept), `and ${rows.length - kept} more batches`];
      }
    }
    terminal.redraw([header, ...body].map((line) => fit(line, terminal.columns())));
  };
  const stopResize = terminal.onResize(draw);
  try {
    while (!signal.aborted) {
      draw();
      await wait(REDRAW_MS, signal);
    }
  } finally {
    // The last board stays on screen, and the prompt comes back on a line of its own.
    stopResize();
    terminal.finish();
  }
  return { exitCode: 0, stdout: '', stderr: '' };
};
