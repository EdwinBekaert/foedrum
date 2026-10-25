// The terminal `foedrum brew` keeps a live line on (ADR 0174): when it is given, and what it does to
// the stream, which is Node's `tty.WriteStream` (cursorTo, clearLine, write; no escape written by hand).
// A fake stream records the calls: no terminal is touched. The board `foedrum status --watch` draws
// (ADR 0188) is on the same stream, with moveCursor and clearScreenDown besides.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { boardTerminal, liveTerminal, type TerminalStream } from '../../src/cli/live-terminal.ts';

/** A stream that records each call, in order, and the resize handlers it holds. */
const fakeStream = (more: Partial<TerminalStream> = {}) => {
  const calls: string[] = [];
  const handlers = new Set<() => void>();
  const stream: TerminalStream = {
    isTTY: true,
    columns: 100,
    rows: 30,
    on: (_event, handler) => {
      handlers.add(handler);
    },
    off: (_event, handler) => {
      handlers.delete(handler);
    },
    cursorTo: (x) => {
      calls.push(`cursorTo(${x})`);
      return true;
    },
    moveCursor: (dx, dy) => {
      calls.push(`moveCursor(${dx}, ${dy})`);
      return true;
    },
    clearLine: (direction) => {
      calls.push(`clearLine(${direction})`);
      return true;
    },
    clearScreenDown: () => {
      calls.push('clearScreenDown()');
      return true;
    },
    write: (text) => {
      calls.push(`write(${JSON.stringify(text)})`);
      return true;
    },
    ...more,
  };
  return { stream, calls, handlers };
};

/**
 * A stream over one screen line, as a console keeps it: `cursorTo` moves the cursor, `write`
 * overwrites from it, `clearLine(1)` clears to its right and `clearLine(0)` the whole line. It
 * keeps the line as it shows after each call.
 */
const fakeScreen = () => {
  let line = '';
  let cursor = 0;
  const shown: string[] = [];
  const show = (): boolean => {
    shown.push(line);
    return true;
  };
  const stream: TerminalStream = {
    isTTY: true,
    columns: 100,
    on: () => {},
    off: () => {},
    cursorTo: (x) => {
      cursor = x;
      return show();
    },
    moveCursor: () => assert.fail('a live line never moves the cursor up'),
    clearLine: (direction) => {
      line = direction === 1 ? line.slice(0, cursor) : direction === 0 ? '' : line.slice(cursor);
      return show();
    },
    clearScreenDown: () => assert.fail('a live line never clears the screen'),
    write: (text) => {
      line = line.slice(0, cursor).padEnd(cursor) + text + line.slice(cursor + text.length);
      cursor += text.length;
      return show();
    },
  };
  return { stream, shown, line: () => line };
};

describe('liveTerminal: when brew keeps a live line', () => {
  it('is given on a TTY with TERM and CI unset, as on Windows', () => {
    assert.notEqual(liveTerminal(fakeStream().stream, {}), undefined);
  });

  it('is given on a TTY whose TERM is not dumb and whose CI is not set', () => {
    assert.notEqual(liveTerminal(fakeStream().stream, { TERM: 'xterm-256color' }), undefined);
  });

  it('is not given when standard output is not a TTY: a pipe, a log, a plugin session', () => {
    assert.equal(liveTerminal(fakeStream({ isTTY: false }).stream, { TERM: 'xterm' }), undefined);
    assert.equal(
      liveTerminal(fakeStream({ isTTY: undefined }).stream, { TERM: 'xterm' }),
      undefined,
    );
  });

  it('is not given when TERM is dumb', () => {
    assert.equal(liveTerminal(fakeStream().stream, { TERM: 'dumb' }), undefined);
  });

  it('is not given when CI is set', () => {
    assert.equal(liveTerminal(fakeStream().stream, { TERM: 'xterm', CI: 'true' }), undefined);
  });

  it('is given whatever NO_COLOR says: the line uses no colour', () => {
    assert.notEqual(liveTerminal(fakeStream().stream, { TERM: 'xterm', NO_COLOR: '1' }), undefined);
  });
});

describe('liveTerminal: what it does to the stream', () => {
  const terminalOf = (more: Partial<TerminalStream> = {}) => {
    const fake = fakeStream(more);
    const terminal = liveTerminal(fake.stream, { TERM: 'xterm' });
    assert.ok(terminal, 'a terminal is given');
    return { ...fake, terminal };
  };

  it('reads the width of the stream each time, none while it is unknown', () => {
    const fake = fakeStream({ columns: 120 });
    const terminal = liveTerminal(fake.stream, {});
    assert.equal(terminal?.columns(), 120);
    fake.stream.columns = 60;
    assert.equal(terminal?.columns(), 60);
    fake.stream.columns = undefined;
    assert.equal(terminal?.columns(), undefined);
  });

  it('rewrites by going to the line start, writing the text without a line feed, then clearing to its right (ADR 0179)', () => {
    const { terminal, calls } = terminalOf();
    terminal.rewrite('| brew #1 / 5s');
    assert.deepEqual(calls, ['cursorTo(0)', 'write("| brew #1 / 5s")', 'clearLine(1)']);
  });

  it('leaves nothing of a longer line behind a shorter one, and never shows a blank line between two (ADR 0179)', () => {
    const screen = fakeScreen();
    const terminal = liveTerminal(screen.stream, {});
    assert.ok(terminal, 'a terminal is given');
    terminal.rewrite('| 1m 0s / implement #1 / 1m 0s / turn 14 / Edit src/a.ts');
    screen.shown.length = 0;
    terminal.rewrite('/ 1m 1s / gauge #1 / 0s');
    assert.equal(screen.line(), '/ 1m 1s / gauge #1 / 0s');
    assert.ok(
      screen.shown.every((line) => line !== ''),
      `a blank frame: ${JSON.stringify(screen.shown)}`,
    );
  });

  it('clears by going to the line start and clearing the line, writing nothing', () => {
    const { terminal, calls } = terminalOf();
    terminal.clear();
    assert.deepEqual(calls, ['cursorTo(0)', 'clearLine(0)']);
  });

  it('prints a lasting line over the live line: clears it, writes the line, and draws the live line again', () => {
    const { terminal, calls } = terminalOf();
    terminal.rewrite('| brew #1 / 5s');
    calls.length = 0;
    terminal.print('foedrum brew: removed a stale index.lock');
    assert.deepEqual(calls, [
      'cursorTo(0)',
      'clearLine(0)',
      'write("foedrum brew: removed a stale index.lock\\n")',
      'cursorTo(0)',
      'write("| brew #1 / 5s")',
      'clearLine(1)',
    ]);
  });

  it('prints a lasting line alone when no live line is on screen, also once it was cleared', () => {
    const { terminal, calls } = terminalOf();
    terminal.print('first');
    terminal.rewrite('| brew #1 / 5s');
    terminal.clear();
    calls.length = 0;
    terminal.print('second');
    assert.deepEqual(calls, ['write("second\\n")']);
  });

  it('calls the handler when the stream is resized, until the returned function stops it', () => {
    const { terminal, handlers } = terminalOf();
    let resized = 0;
    const stop = terminal.onResize(() => {
      resized += 1;
    });
    assert.equal(handlers.size, 1);
    for (const handler of handlers) handler();
    assert.equal(resized, 1);
    stop();
    assert.equal(handlers.size, 0);
  });
});

/**
 * A stream over a screen of lines, as a console keeps them: the cursor has a column and a line,
 * `write` overwrites from it and a line feed goes to the start of the next line, `clearLine(1)`
 * clears to the right of the cursor, `clearScreenDown` clears the rest of its line and every line
 * below. It keeps the screen as it shows after each call.
 */
const fakeBoardScreen = () => {
  const screen: string[] = [''];
  let column = 0;
  let line = 0;
  const shown: string[][] = [];
  const show = (): boolean => {
    shown.push([...screen]);
    return true;
  };
  const write = (text: string): void => {
    const row = screen[line] ?? '';
    screen[line] = row.slice(0, column).padEnd(column) + text + row.slice(column + text.length);
    column += text.length;
  };
  const stream: TerminalStream = {
    isTTY: true,
    columns: 100,
    rows: 30,
    on: () => {},
    off: () => {},
    cursorTo: (x) => {
      column = x;
      return show();
    },
    moveCursor: (dx, dy) => {
      column = Math.max(0, column + dx);
      line = Math.max(0, line + dy);
      screen[line] ??= '';
      return show();
    },
    clearLine: (direction) => {
      const row = screen[line] ?? '';
      screen[line] =
        direction === 1 ? row.slice(0, column) : direction === 0 ? '' : row.slice(column);
      return show();
    },
    clearScreenDown: () => {
      screen[line] = (screen[line] ?? '').slice(0, column);
      screen.length = line + 1;
      return show();
    },
    write: (text) => {
      text.split('\n').forEach((part, i) => {
        if (i > 0) {
          line += 1;
          column = 0;
          screen[line] ??= '';
        }
        write(part);
      });
      return show();
    },
  };
  return { stream, shown, lines: () => [...screen] };
};

describe('boardTerminal: when status --watch draws a board', () => {
  it('is given on a TTY with TERM and CI unset, as on Windows', () => {
    assert.notEqual(boardTerminal(fakeStream().stream, {}), undefined);
  });

  it('is given on a TTY whose TERM is not dumb and whose CI is not set', () => {
    assert.notEqual(boardTerminal(fakeStream().stream, { TERM: 'xterm-256color' }), undefined);
  });

  it('is not given when standard output is not a TTY: a pipe, a log, a plugin session', () => {
    assert.equal(boardTerminal(fakeStream({ isTTY: false }).stream, { TERM: 'xterm' }), undefined);
    assert.equal(
      boardTerminal(fakeStream({ isTTY: undefined }).stream, { TERM: 'xterm' }),
      undefined,
    );
  });

  it('is not given when TERM is dumb', () => {
    assert.equal(boardTerminal(fakeStream().stream, { TERM: 'dumb' }), undefined);
  });

  it('is not given when CI is set', () => {
    assert.equal(boardTerminal(fakeStream().stream, { TERM: 'xterm', CI: 'true' }), undefined);
  });
});

describe('boardTerminal: what it does to the stream (ADR 0188)', () => {
  const boardOf = (more: Partial<TerminalStream> = {}) => {
    const fake = fakeStream(more);
    const board = boardTerminal(fake.stream, { TERM: 'xterm' });
    assert.ok(board, 'a board terminal is given');
    return { ...fake, board };
  };

  it('reads the width and the height of the stream each time, none while one is unknown', () => {
    const fake = fakeStream({ columns: 120, rows: 40 });
    const board = boardTerminal(fake.stream, {});
    assert.equal(board?.columns(), 120);
    assert.equal(board?.rows(), 40);
    fake.stream.columns = 60;
    fake.stream.rows = 12;
    assert.equal(board?.columns(), 60);
    assert.equal(board?.rows(), 12);
    fake.stream.columns = undefined;
    fake.stream.rows = undefined;
    assert.equal(board?.columns(), undefined);
    assert.equal(board?.rows(), undefined);
  });

  it('writes the first board as lines: each line then clearLine(1), a line feed between lines, never moving the cursor up', () => {
    const { board, calls } = boardOf();
    board.redraw(['2 live batches', 'row one', 'row two']);
    // The cursor is at the start of a line already, so a move to column 0 is no matter here.
    assert.deepEqual(
      calls.filter((call) => call !== 'cursorTo(0)'),
      [
        'write("2 live batches")',
        'clearLine(1)',
        'write("\\n")',
        'write("row one")',
        'clearLine(1)',
        'write("\\n")',
        'write("row two")',
        'clearLine(1)',
        'clearScreenDown()',
      ],
    );
  });

  it('redraws by going back up to the first line, then each line over the old one and clearLine(1), line feeds between, clearScreenDown last, with nothing cleared before the text', () => {
    const { board, calls } = boardOf();
    board.redraw(['2 live batches', 'row one', 'row two']);
    calls.length = 0;
    board.redraw(['2 live batches', 'row one!', 'row two!']);
    assert.deepEqual(calls, [
      'moveCursor(0, -2)',
      'cursorTo(0)',
      'write("2 live batches")',
      'clearLine(1)',
      'write("\\n")',
      'write("row one!")',
      'clearLine(1)',
      'write("\\n")',
      'write("row two!")',
      'clearLine(1)',
      'clearScreenDown()',
    ]);
  });

  it('goes back up by the lines of the board before, whatever the new board has', () => {
    const { board, calls } = boardOf();
    board.redraw(['a', 'b', 'c', 'd']);
    calls.length = 0;
    board.redraw(['e']);
    assert.equal(calls[0], 'moveCursor(0, -3)');
  });

  it('leaves nothing of a longer board behind a shorter one, and never shows a blank screen between two boards', () => {
    const screen = fakeBoardScreen();
    const board = boardTerminal(screen.stream, {});
    assert.ok(board, 'a board terminal is given');
    board.redraw(['4 live batches', 'first row of the old board', 'second row', 'third row']);
    screen.shown.length = 0;
    board.redraw(['1 live batch', 'the only row']);
    assert.deepEqual(screen.lines(), ['1 live batch', 'the only row']);
    assert.ok(
      screen.shown.every((frame) => frame.some((row) => row !== '')),
      `a blank frame: ${JSON.stringify(screen.shown)}`,
    );
    assert.ok(
      screen.shown.every((frame) => frame[0] !== ''),
      `the first line was blank: ${JSON.stringify(screen.shown)}`,
    );
  });

  it('draws a longer board over a shorter one', () => {
    const screen = fakeBoardScreen();
    const board = boardTerminal(screen.stream, {});
    assert.ok(board, 'a board terminal is given');
    board.redraw(['1 live batch', 'row']);
    board.redraw(['3 live batches', 'row one', 'row two', 'row three']);
    assert.deepEqual(screen.lines(), ['3 live batches', 'row one', 'row two', 'row three']);
  });

  it('finishes by leaving the board on screen and writing a line feed, clearing nothing', () => {
    const { board, calls } = boardOf();
    board.redraw(['1 live batch', 'row']);
    calls.length = 0;
    board.finish();
    assert.deepEqual(calls, ['write("\\n")']);
  });

  it('calls the handler when the stream is resized, until the returned function stops it', () => {
    const { board, handlers } = boardOf();
    let resized = 0;
    const stop = board.onResize(() => {
      resized += 1;
    });
    assert.equal(handlers.size, 1);
    for (const handler of handlers) handler();
    assert.equal(resized, 1);
    stop();
    assert.equal(handlers.size, 0);
  });
});
