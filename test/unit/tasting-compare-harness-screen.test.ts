// The screen of scripts/tasting-compare/harness.ts (#1156): the live line a run the harness brews
// shows as `foedrum brew` does, given by the same live terminal and the same rule (ADR 0174), and the
// lines of the harness that go over it. A fake stream records the calls: no terminal is touched.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { harnessScreen, liveShellOf } from '../../scripts/tasting-compare/harness.ts';
import type { TerminalStream } from '../../src/cli/live-terminal.ts';
import type { ServeShell } from '../../src/cli/serve.ts';
import { ghOver } from '../helpers/fake-gh.ts';
import { fakeGitHubApi } from '../helpers/fake-github-api.ts';
import { fakeScreen } from '../helpers/fake-screen.ts';

/** A stream that records each call, in order. */
const fakeStream = (more: Partial<TerminalStream> = {}) => {
  const calls: string[] = [];
  const stream: TerminalStream = {
    isTTY: true,
    columns: 100,
    rows: 30,
    on: () => {},
    off: () => {},
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
  return { stream, calls };
};

const START = 'tasting-compare: diff-1';
const END = 'tasting-compare: diff-1 ended merged in 42 s';

describe('harnessScreen: the live line of a run on a terminal (ADR 0174)', () => {
  const onTerminal = () => {
    const fake = fakeStream();
    const screen = harnessScreen(fake.stream, { TERM: 'xterm-256color' });
    assert.ok(screen.terminal, 'a live terminal is given');
    return { ...fake, screen, terminal: screen.terminal };
  };

  it('gives the live terminal of the stream, whose live line is drawn there', () => {
    const { terminal, calls } = onTerminal();
    terminal.rewrite('| brew started 3s ago / implement #1');
    assert.deepEqual(calls, [
      'cursorTo(0)',
      'write("| brew started 3s ago / implement #1")',
      'clearLine(1)',
    ]);
  });

  it('reads the width of the stream for the live line', () => {
    const fake = fakeStream({ columns: 77 });
    const screen = harnessScreen(fake.stream, {});
    assert.equal(screen.terminal?.columns(), 77);
  });

  it('prints a lasting line as a plain line while no live line is on screen', () => {
    const { screen, calls } = onTerminal();
    screen.say(START);
    assert.deepEqual(calls, [`write(${JSON.stringify(`${START}\n`)})`]);
  });

  it('prints a lasting line over the live line: clears it, writes the line, draws the live line again', () => {
    const { screen, terminal, calls } = onTerminal();
    terminal.rewrite('| ordered 5s ago / gauge #1');
    calls.length = 0;
    screen.say(END);
    assert.deepEqual(calls, [
      'cursorTo(0)',
      'clearLine(0)',
      `write(${JSON.stringify(`${END}\n`)})`,
      'cursorTo(0)',
      'write("| ordered 5s ago / gauge #1")',
      'clearLine(1)',
    ]);
  });

  it('draws again the live line the run drew last, not an older one', () => {
    const { screen, terminal, calls } = onTerminal();
    terminal.rewrite('| ordered 5s ago / implement #1');
    terminal.rewrite('/ ordered 6s ago / gauge #1');
    calls.length = 0;
    screen.say(START);
    assert.equal(calls[calls.length - 2], 'write("/ ordered 6s ago / gauge #1")');
  });

  it('takes the live line off the screen with clear, and no lasting line draws it again', () => {
    const { screen, terminal, calls } = onTerminal();
    terminal.rewrite('| ordered 5s ago / gauge #1');
    calls.length = 0;
    screen.clear();
    assert.deepEqual(calls, ['cursorTo(0)', 'clearLine(0)']);
    calls.length = 0;
    screen.say(END);
    assert.deepEqual(calls, [`write(${JSON.stringify(`${END}\n`)})`]);
  });
});

describe('harnessScreen: where a run shows no live line, as before', () => {
  const plain = (stream: TerminalStream, env: Record<string, string | undefined>) => {
    const screen = harnessScreen(stream, env);
    assert.equal(screen.terminal, undefined);
    return screen;
  };

  const cases: [string, Partial<TerminalStream>, Record<string, string | undefined>][] = [
    ['standard output is not a TTY: a pipe or a log', { isTTY: false }, { TERM: 'xterm' }],
    ['standard output has no isTTY', { isTTY: undefined }, { TERM: 'xterm' }],
    ['TERM is dumb', {}, { TERM: 'dumb' }],
    ['CI is set', {}, { TERM: 'xterm', CI: 'true' }],
  ];
  for (const [name, more, env] of cases) {
    it(`gives no live terminal when ${name}`, () => {
      const { stream } = fakeStream(more);
      assert.equal(harnessScreen(stream, env).terminal, undefined);
    });

    it(`prints each line as a plain line, touching nothing else of the stream, when ${name}`, () => {
      const { stream, calls } = fakeStream(more);
      const screen = plain(stream, env);
      screen.say(START);
      screen.say(END);
      assert.deepEqual(calls, [
        `write(${JSON.stringify(`${START}\n`)})`,
        `write(${JSON.stringify(`${END}\n`)})`,
      ]);
    });

    it(`clears nothing when ${name}`, () => {
      const { stream, calls } = fakeStream(more);
      plain(stream, env).clear();
      assert.deepEqual(calls, []);
    });
  }
});

describe('liveShellOf: the shell a run brews with', () => {
  const api = fakeGitHubApi({ login: 'ann', issues: {} });
  const t0 = new Date('2026-11-17T10:00:00Z');
  const shell: ServeShell = {
    out: () => assert.fail('no line is printed here'),
    signal: new AbortController().signal,
    clock: () => t0,
    wait: async () => assert.fail('nothing waits here'),
    lock: () => assert.fail('no lock is taken here'),
    openStore: () => assert.fail('no store is opened here'),
    stateBranch: () => assert.fail('no state branch is used here'),
    worktrees: () => Promise.reject(new Error('no worktree is made here')),
    merge: () => assert.fail('no merge is made here'),
    push: () => assert.fail('no push is made here'),
    runner: () => assert.fail('no brewer runs here'),
    exec: () => Promise.reject(new Error('no check runs here')),
    setup: () => Promise.reject(new Error('no setup runs here')),
    gh: ghOver(api.fetch).exec,
    git: () => Promise.reject(new Error('no git runs here')),
    intervalMs: 1234,
  };

  it('sets the terminal of the screen on the shell and keeps the rest of it', () => {
    const { terminal } = fakeScreen(80);
    const live = liveShellOf(shell, { say: () => {}, terminal, clear: () => {} });
    assert.equal(live.terminal, terminal);
    assert.equal(live.out, shell.out);
    assert.equal(live.clock, shell.clock);
    assert.equal(live.gh, shell.gh);
    assert.equal(live.intervalMs, 1234);
  });

  it('leaves the shell without a terminal where the screen has none', () => {
    const live = liveShellOf(shell, { say: () => {}, terminal: undefined, clear: () => {} });
    assert.equal('terminal' in live, false);
    assert.equal(live.out, shell.out);
    assert.equal(live.intervalMs, 1234);
  });
});
