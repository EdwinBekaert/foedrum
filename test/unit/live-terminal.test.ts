// The terminal `foedrum brew` keeps a live line on (ADR 0174): when it is given, and what it does to
// the stream, which is Node's `tty.WriteStream` (cursorTo, clearLine, write; no escape written by hand).
// A fake stream records the calls: no terminal is touched.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { liveTerminal, type TerminalStream } from '../../src/cli/live-terminal.ts';

/** A stream that records each call, in order, and the resize handlers it holds. */
const fakeStream = (more: Partial<TerminalStream> = {}) => {
  const calls: string[] = [];
  const handlers = new Set<() => void>();
  const stream: TerminalStream = {
    isTTY: true,
    columns: 100,
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
    clearLine: (direction) => {
      calls.push(`clearLine(${direction})`);
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
    clearLine: (direction) => {
      line = direction === 1 ? line.slice(0, cursor) : direction === 0 ? '' : line.slice(cursor);
      return show();
    },
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
