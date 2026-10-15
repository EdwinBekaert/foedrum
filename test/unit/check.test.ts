// npm run check's runner, with the process runner injected; the real steps run in every
// `npm run check` and in CI (ADR 0021).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkSteps, runCheck } from '../../scripts/check.ts';
import type { ProcessOutcome, RunProcess } from '../../scripts/process-runner.ts';

const execPath = '/usr/local/bin/node';
const npmCli = '/usr/local/lib/node_modules/npm/bin/npm-cli.js';
const env = { npm_execpath: npmCli };

// A fake process runner whose processes finish only when the test says so.
const pendingProcesses = () => {
  const calls: {
    file: string;
    args: string[];
    cwd: string;
    finish: (o: ProcessOutcome) => void;
    reject: (error: Error) => void;
  }[] = [];
  const runProcess: RunProcess = (file, args, cwd) =>
    new Promise((finish, reject) => {
      calls.push({ file, args, cwd, finish, reject });
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
    cwd: '/work/tree',
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
    const done = runCheck({ env, execPath, runProcess, cwd: '/work/tree', write: () => {} });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(
      calls.map(({ file, args, cwd }) => ({ file, args, cwd })),
      checkSteps(npmCli).map(({ args }) => ({ file: execPath, args, cwd: '/work/tree' })),
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
      cwd: '/work/tree',
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
        cwd: '/work/tree',
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
