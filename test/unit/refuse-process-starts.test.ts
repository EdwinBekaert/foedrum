import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PROCESS_STARTS, refuseProcessStarts } from '../../scripts/refuse-process-starts.ts';

const IN_TEST_PROCESS = { NODE_TEST_CONTEXT: 'child-v8' };

// A stand-in for node:child_process's module object: each function that starts a process returns
// its own name, and one export starts nothing.
const fakeChildProcess = (): Record<string, unknown> => ({
  ...Object.fromEntries(PROCESS_STARTS.map((name) => [name, () => name])),
  ChildProcess: 'class',
});

// Runs refuseProcessStarts on a fake module object and records what it did.
const refuse = (env: NodeJS.ProcessEnv) => {
  const childProcess = fakeChildProcess();
  const synced: Record<string, unknown>[] = [];
  const hooks: (() => void)[] = [];
  refuseProcessStarts({
    env,
    childProcess,
    syncBuiltinESMExports: () => synced.push({ ...childProcess }),
    after: (hook) => hooks.push(hook),
  });
  return { childProcess, synced, hooks };
};

const callOf = (childProcess: Record<string, unknown>, name: string) => () =>
  (childProcess[name] as (...args: unknown[]) => unknown)('git', ['status']);

describe('refuseProcessStarts', () => {
  it('changes nothing outside a test process, so the runner still starts the test files', () => {
    const { childProcess, synced, hooks } = refuse({});
    assert.deepEqual(
      PROCESS_STARTS.map((name) => callOf(childProcess, name)()),
      [...PROCESS_STARTS],
    );
    assert.equal(synced.length, 0);
    assert.equal(hooks.length, 0);
  });

  for (const name of PROCESS_STARTS) {
    it(`makes ${name} throw in a test process, naming ADR 0021 and test/integration/`, () => {
      const { childProcess } = refuse(IN_TEST_PROCESS);
      assert.throws(callOf(childProcess, name), (error: Error) => {
        assert.match(error.message, new RegExp(`\\b${name}\\b`));
        assert.match(error.message, /ADR 0021/);
        assert.match(error.message, /test\/integration\//);
        return true;
      });
    });
  }

  it('leaves the exports that start nothing alone', () => {
    const { childProcess } = refuse(IN_TEST_PROCESS);
    assert.equal(childProcess.ChildProcess, 'class');
  });

  it('copies the throwing functions to the named exports once they are in place', () => {
    const { childProcess, synced } = refuse(IN_TEST_PROCESS);
    assert.equal(synced.length, 1);
    for (const name of PROCESS_STARTS) assert.equal(synced[0]?.[name], childProcess[name]);
  });

  it('registers an after hook that passes when no process start was refused', () => {
    const { hooks } = refuse(IN_TEST_PROCESS);
    assert.equal(hooks.length, 1);
    assert.doesNotThrow(() => hooks[0]?.());
  });

  it('fails the file from the after hook when the code under test caught the refusal', () => {
    const { childProcess, hooks } = refuse(IN_TEST_PROCESS);
    let caught: Error | undefined;
    try {
      callOf(childProcess, 'spawn')();
    } catch (error) {
      caught = error as Error;
    }
    try {
      callOf(childProcess, 'execFileSync')();
    } catch {
      // Swallowed, as a runner that reports a start failure as a result does.
    }
    assert.throws(
      () => hooks[0]?.(),
      (error: Error) => {
        assert.match(error.message, /2 process starts/);
        assert.match(error.message, /ADR 0021/);
        assert.match(error.message, /test\/integration\//);
        // The first refused call's stack, so the file and import that started it show.
        assert.ok(caught?.stack !== undefined && error.message.includes(caught.stack));
        return true;
      },
    );
  });
});
