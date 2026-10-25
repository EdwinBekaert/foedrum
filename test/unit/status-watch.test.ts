// `foedrum status --watch` (ADR 0188): the board of the live batches, drawn on a fake terminal from
// a fake store with the shell's clock and wait, so no wall clock and no terminal is touched; and
// how the command layer hands the flag to the terminal-side function it is given.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { columns } from '../../src/cli/columns.ts';
import type { BoardTerminal } from '../../src/cli/live-terminal.ts';
import { type CliContext, type CliResult, runCli } from '../../src/cli/run.ts';
import { type WatchShell, watchStatus } from '../../src/cli/status-watch.ts';
import type { EventStore } from '../../src/engine/event-store.ts';
import { fold, type State } from '../../src/engine/fold.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import { StatusCommand } from '../../src/schemas/commands.ts';
import type { Event } from '../../src/schemas/events.ts';
import { linux } from '../helpers/doctor-facts.ts';

const T0 = Date.parse('2026-10-25T10:00:00.000Z');
const ROUTE_BY = '2026-12-31T00:00:00.000Z';
const REMIND = '2026-10-27T09:00:00.000Z';
const DEADLINE = '2026-10-25T12:00:00.000Z';
const ROUTED = `to be routed by ${ROUTE_BY}`;

/** `ms` after the epoch as the store records a time. */
const iso = (ms: number): string => new Date(ms).toISOString();

const ordered = (issue: number, at?: string): Event => ({
  type: 'batch.ordered',
  batchId: `${issue}-1`,
  order: { issue },
  routeBy: ROUTE_BY,
  ...(at === undefined ? {} : { at }),
});

const scheduled = (issue: number, stepId: string, attempt = 1): Event => ({
  type: 'step.scheduled',
  batchId: `${issue}-1`,
  stepId,
  attempt,
  deadlineAt: DEADLINE,
});

const started = (issue: number, stepId: string, attempt = 1): Event => ({
  type: 'step.started',
  batchId: `${issue}-1`,
  stepId,
  attempt,
});

const finished = (issue: number, stepId: string, attempt = 1): Event => ({
  type: 'step.finished',
  batchId: `${issue}-1`,
  stepId,
  attempt,
  outcome: { kind: 'succeeded', output: {} },
});

/** A batch that brews `stepId` now: ordered at `at`, if it says so, and the attempt started. */
const brewing = (issue: number, stepId: string, at?: string): Event[] => [
  ordered(issue, at),
  scheduled(issue, stepId),
  started(issue, stepId),
];

const blocked = (issue: number, summary: string): Event => ({
  type: 'batch.stuck',
  batchId: `${issue}-1`,
  reason: { kind: 'blocked', stepId: 'review', blockerKind: 'findings', summary },
  options: ['retry', 'cancel'],
  remindAt: REMIND,
});

const stateOf = (events: readonly Event[]): State => fold(events);

/** A terminal that keeps each board it is given, in order, and the calls besides, in order. */
const fakeBoard = (size: { columns: number | undefined; rows: number | undefined }) => {
  const frames: string[][] = [];
  const calls: string[] = [];
  const handlers = new Set<() => void>();
  const terminal: BoardTerminal = {
    columns: () => size.columns,
    rows: () => size.rows,
    onResize: (handler) => {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    redraw: (lines) => {
      frames.push([...lines]);
      calls.push('redraw');
    },
    finish: () => {
      calls.push('finish');
    },
  };
  return { terminal, frames, calls, handlers, size };
};

interface Watching {
  /** The state each read of the store gives; the last one goes on being given. */
  states?: readonly State[];
  columns?: number | undefined;
  rows?: number | undefined;
  /** How far the fake clock goes at each wait. */
  step?: number;
  /** The wait that aborts the signal, as Ctrl+C does. */
  waits?: number;
  onWait?: (n: number, board: ReturnType<typeof fakeBoard>) => void;
}

/** Runs the watch on a fake terminal, clock and store until the `waits`-th wait stops it. */
const watched = async ({
  states = [stateOf([])],
  columns: width = 200,
  rows = 50,
  step = 1000,
  waits = 1,
  onWait,
}: Watching = {}) => {
  const board = fakeBoard({ columns: width, rows });
  const controller = new AbortController();
  const waited: number[] = [];
  const framesAtWait: number[] = [];
  let now = T0;
  let reads = 0;
  const shell: WatchShell = {
    terminal: board.terminal,
    state: () => states[Math.min(reads++, states.length - 1)] as State,
    signal: controller.signal,
    clock: () => new Date(now),
    wait: async (ms) => {
      waited.push(ms);
      framesAtWait.push(board.frames.length);
      now += step;
      onWait?.(waited.length, board);
      if (waited.length >= waits) controller.abort();
    },
  };
  const result = await watchStatus(shell);
  return { result, ...board, waited, framesAtWait, reads: () => reads };
};

describe('foedrum status --watch: the board of the live batches (ADR 0188)', () => {
  it('says there are no live batches when the store has none', async () => {
    const { frames } = await watched({ states: [stateOf([])] });
    assert.deepEqual(frames[0], ['No live batches.']);
  });

  it('says there are no live batches when every batch is on tap or cancelled', async () => {
    const events: Event[] = [
      ordered(15),
      {
        type: 'batch.on_tap',
        batchId: '15-1',
        pullRequests: ['https://github.com/acme/app/pull/7'],
      },
      ordered(16),
      { type: 'batch.cancelled', batchId: '16-1', by: 'bob', via: 'comment' },
    ];
    const { frames } = await watched({ states: [stateOf(events)] });
    assert.deepEqual(frames[0], ['No live batches.']);
  });

  it('counts one live batch as one', async () => {
    const { frames } = await watched({ states: [stateOf([ordered(11)])] });
    assert.equal(frames[0]?.[0], '1 live batch');
  });

  it('shows a row for each batch in Ordered, Brewing, Conditioning or Stuck, in the order they were ordered, and leaves On Tap and Cancelled out', async () => {
    const events: Event[] = [
      ordered(11),
      ordered(12),
      scheduled(12, 'implement'),
      ordered(13),
      {
        type: 'batch.waiting',
        batchId: '13-1',
        on: { kind: 'merge', pullRequest: 'https://github.com/acme/app/pull/8' },
        remindAt: REMIND,
      },
      ordered(14),
      blocked(14, 'denied Bash(curl)'),
      ordered(15),
      {
        type: 'batch.on_tap',
        batchId: '15-1',
        pullRequests: ['https://github.com/acme/app/pull/7'],
      },
      ordered(16),
      { type: 'batch.cancelled', batchId: '16-1', by: 'bob', via: 'comment' },
    ];
    const { frames } = await watched({ states: [stateOf(events)] });
    assert.deepEqual(frames[0], [
      '4 live batches',
      ...columns(
        [
          ['-', '11-1', '#11', 'ordered', ROUTED],
          ['-', '12-1', '#12', 'brewing', 'implement #1 scheduled'],
          [
            '-',
            '13-1',
            '#13',
            'conditioning',
            `waiting for the merge of https://github.com/acme/app/pull/8; reminder ${REMIND}`,
          ],
          [
            '-',
            '14-1',
            '#14',
            'stuck',
            `blocked at review (findings): denied Bash(curl); reminder ${REMIND}`,
          ],
        ],
        '',
      ),
    ]);
  });

  it("leads each row with the batch's time counted from orderedAt, and a dash without one, the columns aligned", async () => {
    const events = [ordered(12, iso(T0 - 83_000)), ordered(3)];
    const { frames } = await watched({ states: [stateOf(events)] });
    assert.deepEqual(frames[0], [
      '2 live batches',
      `1m 23s  12-1  #12  ordered  ${ROUTED}`,
      `-       3-1   #3   ordered  ${ROUTED}`,
    ]);
  });

  it("counts the batch's time on the shell's clock at each board", async () => {
    const events = [ordered(12, iso(T0 - 83_000))];
    const { frames } = await watched({ states: [stateOf(events)], step: 15_000, waits: 3 });
    assert.equal(frames[0]?.[1], `1m 23s  12-1  #12  ordered  ${ROUTED}`);
    assert.equal(frames[1]?.[1], `1m 38s  12-1  #12  ordered  ${ROUTED}`);
    assert.equal(frames[2]?.[1], `1m 53s  12-1  #12  ordered  ${ROUTED}`);
  });

  it('shows the batch time as 0s when the clock is before the order', async () => {
    const events = [ordered(12, iso(T0 + 60_000))];
    const { frames } = await watched({ states: [stateOf(events)] });
    assert.equal(frames[0]?.[1], `0s  12-1  #12  ordered  ${ROUTED}`);
  });

  it('shows one indented line under a Brewing batch for each running attempt, in the order its row names them', async () => {
    const events: Event[] = [
      ordered(12),
      scheduled(12, 'implement'),
      started(12, 'implement'),
      scheduled(12, 'review'),
      started(12, 'review'),
      ordered(13),
    ];
    const { frames } = await watched({ states: [stateOf(events)] });
    const [brewingRow, orderedRow] = columns(
      [
        ['-', '12-1', '#12', 'brewing', 'implement #1 started, review #1 started'],
        ['-', '13-1', '#13', 'ordered', ROUTED],
      ],
      '',
    );
    assert.deepEqual(frames[0], [
      '2 live batches',
      brewingRow,
      '  implement #1 / 0s',
      '  review #1 / 0s',
      orderedRow,
    ]);
  });

  it('counts an attempt from when the board first saw it run, and drops its line once it finished', async () => {
    const before: Event[] = [ordered(12), scheduled(12, 'implement')];
    const running: Event[] = [...before, started(12, 'implement')];
    const done: Event[] = [...running, finished(12, 'implement')];
    const states = [before, running, running, done].map(stateOf);
    const { frames } = await watched({ states, step: 15_000, waits: 4 });
    const attemptLines = (frame: string[] | undefined) =>
      (frame ?? []).filter((line) => line.startsWith('  '));
    assert.deepEqual(attemptLines(frames[0]), []);
    assert.deepEqual(attemptLines(frames[1]), ['  implement #1 / 0s']);
    assert.deepEqual(attemptLines(frames[2]), ['  implement #1 / 15s']);
    assert.deepEqual(attemptLines(frames[3]), []);
  });

  it('shows no line for an attempt that is only scheduled', async () => {
    const events: Event[] = [ordered(12), scheduled(12, 'implement')];
    const { frames } = await watched({ states: [stateOf(events)] });
    assert.equal(frames[0]?.length, 2);
  });

  it('reads the store afresh at each board', async () => {
    const states = [stateOf([ordered(11)]), stateOf([ordered(11), ordered(12)])];
    const { frames } = await watched({ states, waits: 2 });
    assert.equal(frames[0]?.[0], '1 live batch');
    assert.equal(frames[1]?.[0], '2 live batches');
  });

  it('shows each code point outside U+0020 to U+007E of a row as an escape with four hex digits, so a line break or a control character cannot act on the terminal', async () => {
    const events = [ordered(14), blocked(14, 'caf\u00e9\nforged\u2028line \u001b[2K\u0007')];
    const { frames } = await watched({ states: [stateOf(events)] });
    const [frame = []] = frames;
    assert.equal(frame.length, 2);
    assert.match(
      frame[1] ?? '',
      /blocked at review \(findings\): caf\\u00e9\\u000aforged\\u2028line \\u001b\[2K\\u0007; reminder /,
    );
    for (const line of frame) assert.match(line, /^[ -~]*$/);
  });

  it('cuts each line to the width of the terminal less one, after the escapes', async () => {
    const events = [ordered(14), blocked(14, 'caf\u00e9 and more')];
    const states = [stateOf(events)];
    const wide = (await watched({ states, columns: 300 })).frames[0]?.[1] ?? '';
    const at = wide.indexOf('\\u00e9');
    assert.notEqual(at, -1, wide);
    // The cut falls inside the escape: three characters of it stay.
    const { frames } = await watched({ states, columns: at + 4 });
    assert.deepEqual(frames[0], ['1 live batch', wide.slice(0, at + 3)]);
  });

  it('cuts the lines of the attempts to the width less one too', async () => {
    const { frames } = await watched({ states: [stateOf(brewing(12, 'implement'))], columns: 12 });
    assert.deepEqual(frames[0]?.at(-1), '  implement');
  });

  it("shows the whole board when it fills the terminal's height less one exactly", async () => {
    const events = [...brewing(12, 'implement'), ...brewing(13, 'review')];
    const { frames } = await watched({ states: [stateOf(events)], rows: 6 });
    assert.equal(frames[0]?.length, 5);
    assert.equal(frames[0]?.at(-1), '  review #1 / 0s');
  });

  it('drops the lines of the attempts before any row of a batch when the board does not fit', async () => {
    const events = [...brewing(12, 'implement'), ...brewing(13, 'review')];
    const { frames } = await watched({ states: [stateOf(events)], rows: 4 });
    assert.deepEqual(frames[0], [
      '2 live batches',
      ...columns(
        [
          ['-', '12-1', '#12', 'brewing', 'implement #1 started'],
          ['-', '13-1', '#13', 'brewing', 'review #1 started'],
        ],
        '',
      ),
    ]);
  });

  it('ends a board that is too tall with a line that says how many batches it leaves out, in the height less one', async () => {
    const events = [11, 12, 13, 14, 15, 16].map((issue) => ordered(issue));
    const { frames } = await watched({ states: [stateOf(events)], rows: 6 });
    assert.deepEqual(frames[0], [
      '6 live batches',
      ...columns(
        [
          ['-', '11-1', '#11', 'ordered', ROUTED],
          ['-', '12-1', '#12', 'ordered', ROUTED],
          ['-', '13-1', '#13', 'ordered', ROUTED],
        ],
        '',
      ),
      'and 3 more batches',
    ]);
  });

  it('leaves out the lines of the attempts of a board that is too tall, and says how many batches it leaves out', async () => {
    const events = [12, 13, 14, 15].flatMap((issue) => brewing(issue, 'implement'));
    const { frames } = await watched({ states: [stateOf(events)], rows: 5 });
    assert.deepEqual(frames[0], [
      '4 live batches',
      ...columns(
        [
          ['-', '12-1', '#12', 'brewing', 'implement #1 started'],
          ['-', '13-1', '#13', 'brewing', 'implement #1 started'],
        ],
        '',
      ),
      'and 2 more batches',
    ]);
  });

  it('waits a second between boards, on the shell, and has drawn the first board before it waits', async () => {
    const { waited, framesAtWait } = await watched({ waits: 3 });
    assert.deepEqual(waited, [1000, 1000, 1000]);
    assert.ok((framesAtWait[0] ?? 0) >= 1, 'the first board was drawn before the first wait');
  });

  it('draws the board again, cut to the new size, when the terminal is resized', async () => {
    const events = [
      ordered(14),
      blocked(14, 'a summary of some length that a narrow terminal cuts'),
    ];
    const { frames } = await watched({
      states: [stateOf(events)],
      waits: 2,
      onWait: (n, board) => {
        if (n !== 1) return;
        board.size.columns = 20;
        for (const handler of board.handlers) handler();
      },
    });
    assert.ok((frames[0]?.[1]?.length ?? 0) > 19, 'the first board is as wide as the terminal was');
    assert.ok(frames.length >= 2, 'a board after the resize');
    for (const frame of frames.slice(1)) {
      assert.ok(frame.length > 0);
      for (const line of frame) assert.ok(line.length <= 19, line);
    }
  });

  it('ends on a stop with exit code 0, nothing on the output, the last board left on screen and a line feed, and the resize no longer listened for', async () => {
    const { result, calls, handlers, frames } = await watched({ waits: 3 });
    assert.deepEqual(result, { exitCode: 0, stdout: '', stderr: '' });
    assert.ok(frames.length >= 1);
    assert.equal(calls.at(-1), 'finish');
    assert.equal(calls.filter((call) => call === 'finish').length, 1);
    assert.equal(handlers.size, 0);
  });

  it('listens for a resize while it draws', async () => {
    let listening: number | undefined;
    await watched({
      waits: 2,
      onWait: (n, board) => {
        if (n === 1) listening = board.handlers.size;
      },
    });
    assert.equal(listening, 1);
  });
});

describe('foedrum status --watch: off a terminal', () => {
  it('refuses with one line and exit code 1, reading no store and waiting for nothing', async () => {
    const shell: WatchShell = {
      terminal: undefined,
      state: () => assert.fail('the store was read'),
      signal: new AbortController().signal,
      clock: () => assert.fail('the clock was read'),
      wait: () => assert.fail('it waited'),
    };
    assert.deepEqual(await watchStatus(shell), {
      exitCode: 1,
      stdout: '',
      stderr: 'foedrum status --watch needs a terminal; foedrum status prints the batches once\n',
    });
  });
});

describe('foedrum status --watch: the command layer', () => {
  const storeWith = (events: readonly Event[]): EventStore => {
    const store = openSqliteEventStore(':memory:');
    store.withTransaction((tx) => {
      for (const event of events) tx.append(event);
    });
    return store;
  };

  const context = (overrides: Partial<CliContext> = {}): CliContext => ({
    cwd: '/work/brewery',
    gatherDoctorFacts: async () => linux(),
    openStore: () => undefined,
    openWritableStore: () => undefined,
    recipes: () => ({ find: () => undefined }),
    brewers: () => assert.fail('no brewer files to read'),
    user: () => 'ada',
    surface: 'terminal',
    now: () => new Date(T0),
    readKeptBranches: async () => assert.fail('no kept branch to read'),
    config: () => assert.fail('no foedrum.jsonc to read'),
    claims: () => assert.fail('no claim host to reach'),
    serve: async () => assert.fail('no serve here'),
    brew: async () => assert.fail('no brew here'),
    watch: async () => assert.fail('no watch here'),
    resume: async () => assert.fail('no session to resume'),
    env: {},
    ...overrides,
  });

  const run = (argv: string[], overrides: Partial<CliContext> = {}): Promise<CliResult> =>
    runCli(argv, context(overrides));

  it('runs the function the context gives for --watch, with its result, and opens no store itself', async () => {
    const result = { exitCode: 1, stdout: '', stderr: 'foedrum status --watch: seen\n' };
    let calls = 0;
    const watch = async () => {
      calls++;
      return result;
    };
    const opened = (): EventStore => assert.fail('the command opened the store');
    assert.deepEqual(await run(['status', '--watch'], { watch, openStore: opened }), result);
    assert.equal(calls, 1);
  });

  it('takes the watch flag in the status command schema', () => {
    assert.equal(StatusCommand.safeParse({ command: 'status', watch: true }).success, true);
  });

  it('lists --watch among the options of status in the usage', async () => {
    const { stdout } = await run(['--help']);
    assert.match(stdout, /^ +status \[--watch\] +/m);
  });

  it('prints the plain status byte for byte, without calling the watch', async () => {
    const result = await run(['status'], {
      openStore: () => storeWith([ordered(11), ordered(12)]),
    });
    assert.deepEqual(result, {
      exitCode: 0,
      stdout: `2 batches\n\n  11-1  #11  ordered  ${ROUTED}\n  12-1  #12  ordered  ${ROUTED}\n`,
      stderr: '',
    });
  });
});
