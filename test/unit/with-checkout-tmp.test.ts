// The wrapper that moves the system temp directory into the checkout for npm test, with the
// folder and the process injected; npm test itself runs through it in every npm run check.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { type WithCheckoutTmpOptions, withCheckoutTmp } from '../../scripts/with-checkout-tmp.ts';

const root = join(import.meta.dirname, '..', '..');
const execPath = '/usr/local/bin/node';
const dir = '/work/tree/.foedrum/tmp/tests/tmpdir-abc123';

// Runs the wrapper with fakes and records what happened, in order.
const wrap = async (
  outcome: number | null | Error,
  overrides: Partial<WithCheckoutTmpOptions> = {},
) => {
  const events: string[] = [];
  const runs: { file: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
  let written = '';
  const result = await withCheckoutTmp({
    args: ['--test', 'test/a.test.ts'],
    env: { PATH: '/usr/bin', TEMP: 'C:\\Temp', TMP: 'C:\\Temp', TMPDIR: '/tmp' },
    execPath,
    makeTempDir: () => {
      events.push('make');
      return dir;
    },
    removeDir: async (path) => {
      events.push(`remove ${path}`);
    },
    run: async (file, args, env) => {
      events.push('run');
      runs.push({ file, args, env });
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
    write: (text) => {
      written += text;
    },
    ...overrides,
  }).then(
    (exitCode) => ({ exitCode }),
    (error: unknown) => ({ error }),
  );
  return { result, events, runs, written };
};

describe('withCheckoutTmp', () => {
  it('runs this node with the arguments and TEMP, TMP and TMPDIR set to a fresh folder', async () => {
    const { runs } = await wrap(0);
    assert.deepEqual(runs, [
      {
        file: execPath,
        args: ['--test', 'test/a.test.ts'],
        env: { PATH: '/usr/bin', TEMP: dir, TMP: dir, TMPDIR: dir },
      },
    ]);
  });

  for (const code of [0, 1, 7]) {
    it(`exits with the program's exit code ${code} and removes the folder afterwards`, async () => {
      const { result, events } = await wrap(code);
      assert.deepEqual(result, { exitCode: code });
      assert.deepEqual(events, ['make', 'run', `remove ${dir}`]);
    });
  }

  it('fails when the program could not start or was killed, and removes the folder', async () => {
    const { result, events } = await wrap(null);
    assert.deepEqual(result, { exitCode: 1 });
    assert.deepEqual(events, ['make', 'run', `remove ${dir}`]);
  });

  it('removes the folder when running the program throws, and passes the error on', async () => {
    const failure = new Error('spawn EACCES');
    const { result, events } = await wrap(failure);
    assert.deepEqual(result, { error: failure });
    assert.deepEqual(events, ['make', 'run', `remove ${dir}`]);
  });

  it('fails when the folder cannot be removed, naming it, after a passing run', async () => {
    const { result, written } = await wrap(0, {
      removeDir: async () => {
        throw new Error('EBUSY: resource busy');
      },
    });
    assert.deepEqual(result, { exitCode: 1 });
    assert.ok(written.includes(dir), written);
    assert.match(written, /EBUSY: resource busy/);
  });

  it('passes the run error on and still names the folder when it cannot be removed either', async () => {
    const failure = new Error('spawn EACCES');
    const { result, written } = await wrap(failure, {
      removeDir: async () => {
        throw new Error('EBUSY');
      },
    });
    assert.deepEqual(result, { error: failure });
    assert.ok(written.includes(dir), written);
    assert.match(written, /EBUSY/);
  });

  it('keeps a failing exit code when the folder cannot be removed either', async () => {
    const { result } = await wrap(3, {
      removeDir: async () => {
        throw new Error('EBUSY');
      },
    });
    assert.deepEqual(result, { exitCode: 3 });
  });

  it('fails with a usage line and starts nothing without arguments', async () => {
    const { result, events, written } = await wrap(0, { args: [] });
    assert.deepEqual(result, { exitCode: 2 });
    assert.deepEqual(events, []);
    assert.match(written, /^usage: node scripts\/with-checkout-tmp\.ts <node arguments…>\n$/);
  });
});

describe('package.json', () => {
  it('runs npm test through the wrapper, so coverage files stay in the checkout', () => {
    const { scripts } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    // Node options such as --import may come before --test.
    assert.match(scripts?.test ?? '', /^node scripts\/with-checkout-tmp\.ts (--\S+ \S+ )*--test /);
  });
});
