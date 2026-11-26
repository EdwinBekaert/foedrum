// `foedrum serve`'s wiring of the terminal (ADR 0427): a live line where standard output is a
// terminal that takes it (ADR 0174's rule), every lasting line over it, and plain lines elsewhere.
// A fake host and a fake `run` stand for the process and the Cellar: nothing starts (ADR 0021).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ServeShell } from '../../src/cli/serve.ts';
import { type ServeSetup, serveSetup } from '../../src/cli/serve-config.ts';
import { type ServeHost, serveReady } from '../../src/cli/serve-main.ts';
import { serveInputs } from '../helpers/serve-brewery.ts';

const setup: ServeSetup = (() => {
  const result = serveSetup(serveInputs());
  return result.kind === 'ready' ? result.setup : assert.fail();
})();

// A standard output that records what is done to it, and signals that count their listeners.
const hostOf = (tty: boolean, env: Record<string, string | undefined> = {}) => {
  const events: string[] = [];
  const listening = new Set<() => void>();
  const host: ServeHost = {
    stdout: {
      isTTY: tty,
      columns: 80,
      on: () => undefined,
      off: () => undefined,
      cursorTo: () => events.push('cursorTo') > 0,
      moveCursor: () => true,
      clearLine: () => events.push('clearLine') > 0,
      clearScreenDown: () => true,
      write: (text) => events.push(`write ${text}`) > 0,
    },
    env,
    on: (_name, handler) => listening.add(handler),
    off: (_name, handler) => listening.delete(handler),
  };
  return { host, events, listening };
};

describe('serveReady', () => {
  it('gives serve a terminal on a TTY, and prints every lasting line over its live line', async () => {
    const { host, events } = hostOf(true);
    let seen: ServeShell | undefined;
    const result = await serveReady(setup, 'brewery', undefined, host, async (_setup, shell) => {
      seen = shell;
      shell.terminal?.rewrite('live');
      shell.out('lasting');
      return 3;
    });
    assert.ok(seen?.terminal !== undefined);
    assert.equal(result.exitCode, 3);
    assert.deepStrictEqual(events, [
      'cursorTo',
      'write live',
      'clearLine',
      'cursorTo',
      'clearLine',
      'write lasting\n',
      'cursorTo',
      'write live',
      'clearLine',
    ]);
  });

  it('gives serve no terminal where the rule of ADR 0174 fails, and prints plain lines', async () => {
    const cases: [string, boolean, Record<string, string | undefined>][] = [
      ['no TTY', false, {}],
      ['TERM dumb', true, { TERM: 'dumb' }],
      ['CI set', true, { CI: 'true' }],
    ];
    for (const [name, tty, env] of cases) {
      const { host, events } = hostOf(tty, env);
      let seen: ServeShell | undefined;
      await serveReady(setup, 'brewery', undefined, host, async (_setup, shell) => {
        seen = shell;
        shell.out('lasting');
        return 0;
      });
      assert.ok(seen !== undefined && seen.terminal === undefined, name);
      assert.deepStrictEqual(events, ['write lasting\n'], name);
    }
  });

  it('stops listening for signals once serve returns, or fails', async () => {
    const { host, listening } = hostOf(false);
    await serveReady(setup, 'brewery', undefined, host, async () => {
      assert.ok(listening.size > 0);
      return 0;
    });
    assert.equal(listening.size, 0);
    await assert.rejects(
      serveReady(setup, 'brewery', undefined, host, async () => {
        throw new Error('serve failed');
      }),
      /serve failed/,
    );
    assert.equal(listening.size, 0);
  });
});
