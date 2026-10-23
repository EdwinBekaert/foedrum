// A repository's setup in a check step (ADR 0140): the check runner runs it once in the attempt's
// worktree before the step's checks, through a process runner of its own with the network, and a
// setup that does not pass ends the attempt on its environment (ADR 0021: fake process runners).

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createCheckRunner, type RepositorySetup } from '../../src/checks/check-runner.ts';
import { fold } from '../../src/engine/fold.ts';
import type { StepChecks } from '../../src/engine/recipe-files.ts';
import type { ExecOptions, ExecProcess, ExecResult } from '../../src/platform/processes.ts';
import type { Event } from '../../src/schemas/events.ts';
import type { CheckRef } from '../../src/schemas/recipe.ts';

const worktree = join('/work', 'acme.api', 'attempts', '12-1', 'green', '1');
const ref = { batchId: '12-1', stepId: 'green', attempt: 1 };
const now = new Date('2026-10-17T12:00:00.000Z');
const deadlineAt = '2026-10-17T12:30:00.000Z';
const env = { base: { PATH: '/usr/bin' }, forced: { npm_config_ignore_scripts: 'true' } };

const events: Event[] = [
  { type: 'batch.ordered', batchId: '12-1', order: { issue: 12 }, routeBy: deadlineAt },
  { type: 'batch.recipe_chosen', batchId: '12-1', recipe: 'pale', reason: 'l', source: 'label' },
  { type: 'step.scheduled', ...ref, deadlineAt },
  {
    type: 'step.started',
    ...ref,
    worktree: {
      repo: 'acme/api',
      path: worktree,
      branch: 'foedrum/12-1/green/1',
      commit: 'c'.repeat(40),
    },
  },
];

type Call = { file: string; options: ExecOptions };
type Script = Partial<ExecResult> | 'hang';

/** A process runner that answers as scripted and records each call in `calls` under `name`. */
const fakeExec = (name: string, calls: string[], script: Script = {}) => {
  const seen: Call[] = [];
  const exec: ExecProcess = (file, _args, options) => {
    seen.push({ file, options });
    calls.push(`${name} ${file}`);
    if (script === 'hang') {
      return new Promise((done) => {
        const stopped = () =>
          done({ exitCode: null, stdout: '', stderr: '', output: '', killed: 'stopped' });
        if (options.signal?.aborted) stopped();
        else options.signal?.addEventListener('abort', stopped);
      });
    }
    const output = script.output ?? '';
    return Promise.resolve({ exitCode: 0, stdout: output, stderr: '', output, ...script });
  };
  return { seen, exec };
};

const run = ({
  /** `null`: the repository has no setup. */
  prepare = { command: 'npm ci', timeout: '10m' } as RepositorySetup | null,
  script = {} as Script,
  /** How the test check answers. */
  check = { output: 'ok 1\n' } as Script,
  /** `false`: foedrum.jsonc lists no checks of the repository. */
  listed = true,
  /** The step's checks. */
  checks: refs = ['test'] as CheckRef[],
  platform = 'linux' as NodeJS.Platform,
  clock = () => now,
} = {}) => {
  const calls: string[] = [];
  const checks = fakeExec('check', calls, check);
  const setup = fakeExec('setup', calls, script);
  const stepChecks: StepChecks = {
    find: (recipe, stepId) => (recipe === 'pale' && stepId === 'green' ? refs : undefined),
    any: () => true,
    proves: () => undefined,
    redProof: () => undefined,
  };
  const asked: string[] = [];
  const runner = createCheckRunner({
    state: () => fold(events),
    checks: stepChecks,
    repositoryChecks: () =>
      listed
        ? { build: null, typecheck: null, lint: null, format: null, test: 'npm test' }
        : undefined,
    testReport: () => undefined,
    exec: checks.exec,
    setup: {
      of: (repo) => {
        asked.push(repo);
        return prepare ?? undefined;
      },
      exec: setup.exec,
    },
    git: () => Promise.reject(new Error('a check step reads no commits')),
    clone: () => {
      throw new Error('a check step reads no commits');
    },
    env,
    clock,
    platform,
  });
  const started = runner.start({
    ref,
    limits: { outDoc: { file: 'out.md', schema: undefined as never } },
  });
  return { calls, asked, setup: setup.seen, started };
};

const environment = (summary: string) => ({ kind: 'blocked', blockerKind: 'environment', summary });

describe('createCheckRunner: the repository setup (ADR 0140)', () => {
  it("runs the repository's setup in the worktree before the checks, with its own process runner", async () => {
    const { calls, asked, setup, started } = run({ script: { output: 'added 7 packages\n' } });
    const end = await started.ended;
    assert.deepEqual(asked, ['acme/api']);
    assert.deepEqual(calls, ['setup npm ci', 'check npm test']);
    const options = setup[0]?.options;
    assert.equal(options?.cwd, worktree);
    assert.deepEqual(options?.env, { PATH: '/usr/bin', npm_config_ignore_scripts: 'true' });
    assert.equal(options?.shell, true);
    assert.equal(options?.jobObject, true);
    // Its own timeout, sooner than ten seconds before the step's deadline.
    assert.equal(options?.timeoutMs, 10 * 60_000);
    assert.ok(options?.signal instanceof AbortSignal);
    assert.deepEqual(end, {
      ending: { kind: 'succeeded', output: null },
      readings: [
        {
          result: 'exited',
          setup: true,
          command: 'npm ci',
          exitCode: 0,
          tail: 'added 7 packages\n',
        },
        { result: 'exited', check: 'test', command: 'npm test', exitCode: 0, tail: 'ok 1\n' },
      ],
    });
  });

  it("gives it what is left until ten seconds before the step's deadline when that is sooner", async () => {
    const { setup, started } = run({ prepare: { command: 'npm ci', timeout: '1h' } });
    await started.ended;
    assert.equal(setup[0]?.options.timeoutMs, 30 * 60_000 - 10_000);
  });

  it("runs the setup's command line for the platform", async () => {
    const { calls, started } = run({
      prepare: { command: { run: 'npm ci', windows: 'npm.cmd ci' }, timeout: '10m' },
      platform: 'win32',
    });
    await started.ended;
    assert.deepEqual(calls, ['setup npm.cmd ci', 'check npm test']);
  });

  // Elsewhere the setup runs in the check sandbox with the network kept (ADR 0158).
  it('says the setup ran unsandboxed on native Windows only, as a check', async () => {
    const onWindows = await run({ platform: 'win32' }).started.ended;
    assert.deepEqual(
      onWindows.readings?.map((reading) => 'unsandboxed' in reading && reading.unsandboxed),
      [true, true],
    );
    for (const platform of ['linux', 'darwin'] as const) {
      const end = await run({ platform }).started.ended;
      assert.ok(
        end.readings?.every((reading) => !('unsandboxed' in reading)),
        platform,
      );
    }
  });

  it('runs no setup for a repository that has none', async () => {
    const { calls, started } = run({ prepare: null });
    const end = await started.ended;
    assert.deepEqual(calls, ['check npm test']);
    assert.equal(end.readings?.length, 1);
  });

  it('fails the step as a check failure, not on its environment, when the check after a setup fails', async () => {
    const { calls, started } = run({ check: { exitCode: 1, output: 'not ok 1\n' } });
    const end = await started.ended;
    assert.deepEqual(calls, ['setup npm ci', 'check npm test']);
    assert.deepEqual(end.ending, {
      kind: 'failed',
      retryable: false,
      reason: 'the check "test" (npm test) failed with exit code 1',
    });
    assert.deepEqual(
      end.readings?.map((reading) => [reading.result, 'setup' in reading && reading.setup]),
      [
        ['exited', true],
        ['exited', false],
      ],
    );
  });

  it('ends the attempt on its environment, running no check, when the setup fails', async () => {
    const { calls, started } = run({
      script: { exitCode: 1, output: 'npm ERR! missing package-lock.json\n' },
    });
    const end = await started.ended;
    assert.deepEqual(calls, ['setup npm ci']);
    assert.deepEqual(end, {
      ending: environment('the setup "npm ci" failed with exit code 1'),
      readings: [
        {
          result: 'exited',
          setup: true,
          command: 'npm ci',
          exitCode: 1,
          tail: 'npm ERR! missing package-lock.json\n',
        },
      ],
    });
  });

  it('ends it on its environment when the setup is killed at its timeout or its output limit', async () => {
    const timedOut = await run({ script: { exitCode: null, killed: 'timed-out' } }).started.ended;
    assert.deepEqual(
      timedOut.ending,
      environment(`the setup "npm ci" did not finish within its timeout or the step's deadline`),
    );
    const loud = await run({ script: { exitCode: null, killed: 'too-much-output' } }).started.ended;
    assert.deepEqual(
      loud.ending,
      environment(`the setup "npm ci" wrote more output than the process runner's limit`),
    );
  });

  it('ends it on its environment when a signal ends the setup or it cannot start', async () => {
    const signaled = await run({ script: { exitCode: null, signal: 'SIGKILL' } }).started.ended;
    assert.deepEqual(signaled.ending, environment('the setup "npm ci" was ended by SIGKILL'));
    const unstarted = await run({
      script: { exitCode: null, output: 'spawn /bin/sh ENOENT\n' },
    }).started.ended;
    assert.deepEqual(
      unstarted.ending,
      environment('the setup "npm ci" could not start: spawn /bin/sh ENOENT'),
    );
  });

  it('runs no setup for a step that is blocked before its checks: the repository lists none', async () => {
    const { calls, started } = run({ listed: false });
    const end = await started.ended;
    assert.deepEqual(calls, []);
    assert.deepEqual(end, {
      ending: environment('foedrum.jsonc lists no checks of acme/api for the check "test"'),
    });
  });

  it('runs no setup for a step whose every check is skipped', async () => {
    const { calls, started } = run({ checks: ['lint'] });
    const end = await started.ended;
    assert.deepEqual(calls, []);
    assert.deepEqual(end, {
      ending: { kind: 'succeeded', output: null },
      readings: [{ result: 'skipped', check: 'lint' }],
    });
  });

  it('kills the setup when the engine stops the attempt: it is cancelled', async () => {
    const { calls, started } = run({ script: 'hang' });
    started.stop();
    const end = await started.ended;
    assert.deepEqual(end.ending, { kind: 'cancelled' });
    assert.deepEqual(calls, ['setup npm ci']);
  });
});
