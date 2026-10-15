// npm run check's runner, with the process runner injected; the real steps run in every
// `npm run check` and in CI (ADR 0021).

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { checkSteps, runCheck } from '../../scripts/check.ts';
import type { ReadText } from '../../scripts/deps-sync.ts';
import type { ProcessOutcome, RunOptions, RunProcess } from '../../scripts/process-runner.ts';

const execPath = '/usr/local/bin/node';
const npmCli = '/usr/local/lib/node_modules/npm/bin/npm-cli.js';
const env = { npm_execpath: npmCli };
const cwd = '/work/tree';

// The checkout at cwd, read through the injected reader: its package.json, its lock file and,
// unless it is undefined, npm's record of what it installed.
const lock = JSON.stringify({
  packages: {
    '': { name: 'foedrum' },
    'node_modules/zod': { version: '4.6.5', integrity: 'sha512-z' },
  },
});
const installed = (version: string): string =>
  JSON.stringify({ packages: { 'node_modules/zod': { version, integrity: 'sha512-z' } } });
const checkout =
  (record: string | undefined): ReadText =>
  async (path) =>
    ({
      [join(cwd, 'package.json')]: '{}',
      [join(cwd, 'package-lock.json')]: lock,
      [join(cwd, 'node_modules', '.package-lock.json')]: record,
    })[path];
const upToDate = checkout(installed('4.6.5'));

// A fake process runner whose processes finish only when the test says so.
const pendingProcesses = () => {
  const calls: {
    file: string;
    args: string[];
    cwd: string;
    options: RunOptions | undefined;
    finish: (o: ProcessOutcome) => void;
    reject: (error: Error) => void;
  }[] = [];
  const runProcess: RunProcess = (file, args, cwd, options) =>
    new Promise((finish, reject) => {
      calls.push({ file, args, cwd, options, finish, reject });
    });
  return { calls, runProcess };
};

// Runs the check with the fake runner, then finishes the steps in the given order (by index)
// with the given outcomes (an Error makes the runner reject), and returns the exit code and
// everything written.
const check = async (
  outcomes: (ProcessOutcome | Error)[],
  order = outcomes.map((_, index) => index),
) => {
  const { calls, runProcess } = pendingProcesses();
  let written = '';
  // A rejection comes back as the exit code, so the test's assertions report it; caught at once,
  // since it may come while later steps are still being finished.
  const done = runCheck({
    env,
    execPath,
    runProcess,
    cwd,
    read: upToDate,
    write: (text) => {
      written += text;
    },
  }).catch((error: unknown) => error);
  for (const index of order) {
    await new Promise((resolve) => setImmediate(resolve));
    const call = calls[index];
    // A step that never started would leave runCheck waiting forever; fail here instead.
    assert.ok(call, `step ${index} was not started`);
    const outcome = outcomes[index] as ProcessOutcome | Error;
    if (outcome instanceof Error) call.reject(outcome);
    else call.finish(outcome);
  }
  return { exitCode: await done, written, calls };
};

const green = (output: string): ProcessOutcome => ({ exitCode: 0, output });
const labels = (): string[] => checkSteps(npmCli).map(({ label }) => label);

describe('checkSteps', () => {
  it('are the typecheck, lint, tests and both guards, npm scripts through npm_execpath', () => {
    assert.deepEqual(checkSteps(npmCli), [
      { label: 'npm run typecheck', args: [npmCli, 'run', 'typecheck'] },
      { label: 'npm run lint', args: [npmCli, 'run', 'lint'] },
      { label: 'npm test', args: [npmCli, 'test'] },
      { label: 'node scripts/check-test-layers.ts', args: ['scripts/check-test-layers.ts'] },
      {
        label: 'node scripts/check-deps.ts --offline',
        args: ['scripts/check-deps.ts', '--offline'],
      },
    ]);
  });
});

describe('runCheck', () => {
  const allGreen = (): ProcessOutcome[] => labels().map((label) => green(`${label} ok\n`));

  it('starts every step before any finishes, with this node in the given directory', async () => {
    const { calls, runProcess } = pendingProcesses();
    const done = runCheck({ env, execPath, runProcess, cwd, read: upToDate, write: () => {} });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(
      calls.map(({ file, args, cwd }) => ({ file, args, cwd })),
      checkSteps(npmCli).map(({ args }) => ({ file: execPath, args, cwd })),
    );
    for (const call of calls) call.finish(green(''));
    assert.equal(await done, 0);
  });

  it('passes when every step exits 0', async () => {
    const { exitCode } = await check(allGreen());
    assert.equal(exitCode, 0);
  });

  it('writes each step under its label in step order, whatever order they finish in', async () => {
    const { written } = await check(allGreen(), [4, 2, 0, 3, 1]);
    const expected = labels()
      .map((label) => `> ${label}\n${label} ok\n`)
      .join('');
    assert.equal(written.slice(0, expected.length), expected);
  });

  it('ends output that lacks one with a newline', async () => {
    const { written } = await check(labels().map(() => green('no newline')));
    assert.match(written, /^> npm run typecheck\nno newline\n> npm run lint\n/);
  });

  for (const [name, failed] of [
    ['exits non-zero', { exitCode: 2, output: 'not ok 1 - café\n' }],
    ['could not start or was killed', { exitCode: null, output: 'spawn ENOENT' }],
  ] as const) {
    it(`fails when a step ${name}, keeping every step's output and naming the failed one`, async () => {
      const outcomes = allGreen();
      outcomes[2] = failed;
      const { exitCode, written } = await check(outcomes);
      assert.equal(exitCode, 1);
      for (const label of labels()) assert.ok(written.includes(`> ${label}\n`), label);
      assert.ok(written.includes(failed.output));
      assert.match(written, /✖ npm run check failed: npm test\n$/);
    });
  }

  it('writes a passing step as soon as it and the steps before it are done', async () => {
    const { calls, runProcess } = pendingProcesses();
    let written = '';
    const done = runCheck({
      env,
      execPath,
      runProcess,
      cwd,
      read: upToDate,
      write: (text) => {
        written += text;
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    calls[0]?.finish(green('types ok\n'));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(written, '> npm run typecheck\ntypes ok\n');
    for (const call of calls.slice(1)) call.finish(green(''));
    assert.equal(await done, 0);
  });

  it('writes only the label for a step without output', async () => {
    const { written } = await check(labels().map(() => green('')));
    assert.equal(
      written,
      labels()
        .map((label) => `> ${label}\n`)
        .join(''),
    );
  });

  // The local gate shows only the end of the output, so a failure must not scroll out of it.
  it('writes the failed steps last, just before the summary, after the passing ones', async () => {
    const outcomes = allGreen();
    outcomes[0] = { exitCode: 2, output: 'error TS2322\n' };
    const { written } = await check(outcomes);
    assert.match(written, /^> npm run lint\n/);
    assert.match(
      written,
      /\n> npm run typecheck\nerror TS2322\n✖ npm run check failed: npm run typecheck\n$/,
    );
  });

  it('counts a step whose runner rejects as failed, with the error, and keeps the others', async () => {
    const outcomes: (ProcessOutcome | Error)[] = allGreen();
    outcomes[1] = new Error('spawn EINVAL');
    const { exitCode, written } = await check(outcomes);
    assert.equal(exitCode, 1);
    for (const label of labels()) assert.ok(written.includes(`> ${label}\n`), label);
    assert.match(written, /> npm run lint\n.*spawn EINVAL/);
    assert.match(written, /✖ npm run check failed: npm run lint\n$/);
  });

  it('names every failed step', async () => {
    const outcomes = allGreen();
    outcomes[0] = { exitCode: 1, output: '' };
    outcomes[3] = { exitCode: 1, output: '' };
    const { written } = await check(outcomes);
    assert.match(
      written,
      /✖ npm run check failed: npm run typecheck, node scripts\/check-test-layers\.ts\n$/,
    );
  });

  // The local gate's hook ends after 600 s, without killing the steps or showing their output.
  it('gives every step a deadline well before the gate gives up on the check', async () => {
    const { calls, runProcess } = pendingProcesses();
    const done = runCheck({ env, execPath, runProcess, cwd, read: upToDate, write: () => {} });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.length, labels().length);
    for (const { options } of calls) {
      const timeoutMs = options?.timeoutMs;
      assert.ok(timeoutMs !== undefined && timeoutMs > 0 && timeoutMs <= 300_000, `${timeoutMs}`);
    }
    for (const call of calls) call.finish(green(''));
    assert.equal(await done, 0);
  });

  it("gives every step the check's own deadline and stop signal", async () => {
    const { calls, runProcess } = pendingProcesses();
    const stop = new AbortController();
    const done = runCheck({
      env,
      execPath,
      runProcess,
      cwd,
      read: upToDate,
      write: () => {},
      stepTimeoutMs: 90_000,
      signal: stop.signal,
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(
      calls.map(({ options }) => options),
      labels().map(() => ({ timeoutMs: 90_000, signal: stop.signal })),
    );
    for (const call of calls) call.finish(green(''));
    assert.equal(await done, 0);
  });

  for (const [killed, reason] of [
    ['timed-out', 'timed out after 90 s'],
    ['stopped', 'stopped'],
  ] as const) {
    it(`fails a step the runner killed (${killed}), naming why, and keeps its output`, async () => {
      const { calls, runProcess } = pendingProcesses();
      let written = '';
      const done = runCheck({
        env,
        execPath,
        runProcess,
        cwd,
        read: upToDate,
        write: (text) => {
          written += text;
        },
        stepTimeoutMs: 90_000,
      });
      await new Promise((resolve) => setImmediate(resolve));
      calls.forEach((call, index) => {
        if (index === 2) call.finish({ exitCode: null, output: '▶ suite\n', killed });
        else call.finish(green(''));
      });
      assert.equal(await done, 1);
      assert.match(written, new RegExp(`\\n> npm test\\n▶ suite\\n${reason}\\n`));
      assert.match(written, new RegExp(`✖ npm run check failed: npm test \\(${reason}\\)\\n$`));
    });
  }

  // A worktree without node_modules of its own would otherwise run every step against the
  // packages of the checkout above it (#86).
  for (const [name, record, reason] of [
    ['missing', undefined, 'node_modules/.package-lock.json is missing'],
    [
      'stale',
      installed('4.6.4'),
      'node_modules/zod 4.6.4 is installed, package-lock.json has 4.6.5',
    ],
  ] as const) {
    it(`fails at once with the gate's line when node_modules is ${name}, starting no step`, async () => {
      // Steps that finish at once, so a check that starts them anyway ends, and fails here.
      const calls: string[][] = [];
      const runProcess: RunProcess = async (_file, args) => {
        calls.push(args);
        return green('');
      };
      let written = '';
      const exitCode = await runCheck({
        env,
        execPath,
        runProcess,
        cwd,
        read: checkout(record),
        write: (text) => {
          written += text;
        },
      });
      assert.equal(exitCode, 1);
      assert.equal(
        written,
        `node_modules is out of date with package-lock.json (${reason}); run npm ci\n`,
      );
      assert.deepEqual(calls, []);
    });
  }

  for (const [name, badEnv] of [
    ['missing', {}],
    ['empty', { npm_execpath: '' }],
  ] as const) {
    it(`fails without starting a process when npm_execpath is ${name}`, async () => {
      const { calls, runProcess } = pendingProcesses();
      let written = '';
      const exitCode = await runCheck({
        env: badEnv,
        execPath,
        runProcess,
        cwd,
        read: upToDate,
        write: (text) => {
          written += text;
        },
      });
      assert.equal(exitCode, 1);
      assert.match(written, /npm_execpath is not set: run this as `npm run check`/);
      assert.deepEqual(calls, []);
    });
  }
});
