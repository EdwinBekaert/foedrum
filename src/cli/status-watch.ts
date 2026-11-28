// `foedrum status --watch` (ADR 0188): a board of the live batches, redrawn in place about once a
// second on a terminal, read from the Brewery's store as `foedrum status` reads it.

import { breweryIssueOf, orderName } from '../engine/claim-orders.ts';
import type { State } from '../engine/fold.ts';
import { laneStatus } from '../engine/worktree-claims.ts';
import { messageOf } from '../platform/errors.ts';
import { columns } from './columns.ts';
import { elapsed, fit, runningAttempts } from './live-line.ts';
import type { BoardTerminal } from './live-terminal.ts';
import type { CliResult } from './run.ts';
import { boardRow } from './status.ts';

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

/** Draws the board until `shell.signal` aborts, exit code 0; refuses, exit code 1, off a terminal. */
export const watchStatus = async (shell: WatchShell): Promise<CliResult> => {
  const { terminal, state, signal, clock, wait } = shell;
  if (terminal === undefined) return { exitCode: 1, stdout: '', stderr: `${refusal}\n` };
  // When this board first saw each running attempt run, as `brew` counts `seenAt`.
  let seenAt = new Map<string, number>();
  // The lines of the board of the store as `folded` holds it now, before they are fitted.
  const board = (folded: State): string[] => {
    const now = clock();
    const at = now.getTime();
    const batches = [...folded.batches.values()].filter(({ lane }) => laneStatus(lane) === 'live');
    const seen = new Map<string, number>();
    // A batch's row: its Brewery issue's number, its state, what it does or waits for in a few
    // words, what its attempts took and its age, all short, so the columns stay in view; under it
    // the rest, such as a Stuck reason, on a line a narrow terminal cuts at its end, and a line for
    // each attempt that runs (ADR 0475).
    const groups = batches.map((batch) => {
      const age =
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
      const { cells, message } = boardRow(folded, batch, now);
      const issue = breweryIssueOf(folded, batch);
      const number = issue === undefined ? orderName(folded, batch) : `#${issue}`;
      const lines = message === '' ? attempts : [`  ${message}`, ...attempts];
      return { row: [number, ...cells, age], attempts: lines };
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
        // On a terminal of two rows, only the first line fits.
        const kept = room - 1;
        body = room < 1 ? [] : [...rows.slice(0, kept), `and ${rows.length - kept} more batches`];
      }
    }
    return [header, ...body];
  };
  // The last board of a store that read, which stays on screen while a read fails.
  let last: string[] = [];
  const draw = (): void => {
    let lines: string[];
    try {
      lines = board(state());
      last = lines;
    } catch (error) {
      // A read that fails, such as a store busy while a driver writes, ends no watch: the last
      // board stays, cut where it must be so that it and the line that says so fit in the height
      // less one, and the next board reads again (ADR 0189). From a resize it would be uncaught.
      const message = messageOf(error);
      const height = terminal.rows();
      const kept = height === undefined ? last : last.slice(0, Math.max(0, height - 2));
      lines = [...kept, `could not read the store: ${message}; trying again each second`];
    }
    terminal.redraw(lines.map((line) => fit(line, terminal.columns())));
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
