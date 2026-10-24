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

  it('rewrites by going to the line start, clearing the line, then writing the text without a line feed', () => {
    const { terminal, calls } = terminalOf();
    terminal.rewrite('| brew #1 / 5s');
    assert.deepEqual(calls, ['cursorTo(0)', 'clearLine(0)', 'write("| brew #1 / 5s")']);
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
      'clearLine(0)',
      'write("| brew #1 / 5s")',
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
