// The terminal while `foedrum resume` hands it to claude (ADR 0127): lines wait for claude to give
// it back, and only the console's own signals are claude's meanwhile.

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { foregroundGate } from '../../src/cli/foreground-gate.ts';

describe('foregroundGate (ADR 0127)', () => {
  let written: string[];
  let handlers: Map<string, () => void>;
  let fired: string[];
  let gate: ReturnType<typeof foregroundGate>;
  /** claude in the foreground until `close` is called. */
  let close: () => void;
  let running: Promise<number>;

  beforeEach(() => {
    written = [];
    handlers = new Map();
    fired = [];
    gate = foregroundGate(
      (line) => written.push(line),
      (name, handler) => handlers.set(name, handler),
    );
    for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const) {
      gate.listen(name, () => fired.push(name));
    }
    running = gate.foreground(
      () =>
        new Promise<number>((settle) => {
          close = () => settle(0);
        }),
    );
  });

  const signal = (name: string) => handlers.get(name)?.();

  it('holds the lines written while claude has the terminal, and writes them, in order, once it is back', async () => {
    gate.out('one');
    gate.out('two');
    assert.deepEqual(written, []);
    close();
    assert.equal(await running, 0);
    gate.out('three');
    assert.deepEqual(written, ['one', 'two', 'three']);
  });

  it('leaves Ctrl+C and Ctrl+Break to claude while it runs, and passes them on after', async () => {
    signal('SIGINT');
    signal('SIGBREAK');
    assert.deepEqual(fired, []);
    close();
    await running;
    signal('SIGINT');
    assert.deepEqual(fired, ['SIGINT']);
  });

  it('passes a kill or a closed terminal on at once, also while claude runs', () => {
    signal('SIGTERM');
    signal('SIGHUP');
    assert.deepEqual(fired, ['SIGTERM', 'SIGHUP']);
    close();
  });

  it('gives the terminal back when claude cannot start', async () => {
    close();
    await running;
    await assert.rejects(gate.foreground(() => Promise.reject(new Error('spawn ENOENT'))));
    gate.out('after');
    assert.deepEqual(written, ['after']);
  });
});
