// The check runner (ADR 0069): for an attempt of a check step the driver started, it runs the
// step's checks in the attempt's worktree through an injected process runner (ADR 0021).

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createCheckRunner } from '../../src/checks/check-runner.ts';
import type { RepositoryChecks } from '../../src/checks/gravity.ts';
import { fold } from '../../src/engine/fold.ts';
import type { StepChecks } from '../../src/engine/recipe-files.ts';
import type { ExecOptions, ExecProcess, ExecResult } from '../../src/platform/processes.ts';
import type { Event } from '../../src/schemas/events.ts';
import type { CheckRef } from '../../src/schemas/recipe.ts';

const worktree = join('/work', 'acme.api', 'attempts', '12-1', 'green', '1');
const ref = { batchId: '12-1', stepId: 'green', attempt: 1 };
const now = new Date('2026-10-17T12:00:00.000Z');
const deadlineAt = '2026-10-17T12:30:00.000Z';
// The brewers' environment (ADR 0063): a minimal base and the runner's forced variables.
const env = { base: { PATH: '/usr/bin' }, forced: { npm_config_ignore_scripts: 'true' } };

const ordered: Event[] = [
  { type: 'batch.ordered', batchId: '12-1', order: { issue: 12 }, routeBy: deadlineAt },
  { type: 'batch.recipe_chosen', batchId: '12-1', recipe: 'pale', reason: 'l', source: 'label' },
  { type: 'step.scheduled', ...ref, deadlineAt },
];
const started: Event = {
  type: 'step.started',
  ...ref,
  worktree: {
    repo: 'acme/api',
    path: worktree,
    branch: 'foedrum/12-1/green/1',
    commit: 'c'.repeat(40),
  },
};

const repository: RepositoryChecks = {
  build: null,
  typecheck: 'npm run typecheck',
  lint: 'npm run lint',
  format: null,
  test: 'npm test',
};

type Script = Partial<ExecResult> | 'hang';

/** A process runner that answers each command line as scripted, and records each call. */
const fakeExec = (scripts: Record<string, Script> = {}) => {
  const calls: { file: string; args: readonly string[]; options: ExecOptions }[] = [];
  const exec: ExecProcess = (file, args, options) => {
    calls.push({ file, args, options });
    const script = scripts[file] ?? {};
    if (script === 'hang') {
      return new Promise((done) => {
        options.signal?.addEventListener('abort', () =>
          done({ exitCode: null, stdout: '', stderr: '', output: 'ok 1\n', killed: 'stopped' }),
        );
      });
    }
    const output = script.output ?? '';
    return Promise.resolve({ exitCode: 0, stdout: output, stderr: '', output, ...script });
  };
  return { calls, exec };
};

const setup = ({
  checks = ['test'],
  scripts = {},
  events = [...ordered, started],
  repo = repository,
  platform = 'linux',
  layers = env,
  clock = () => now,
}: {
  checks?: readonly CheckRef[];
  scripts?: Record<string, Script>;
  events?: Event[];
  /** `null`: foedrum.jsonc lists none for the repository. */
  repo?: RepositoryChecks | null;
  platform?: NodeJS.Platform;
  layers?: { base: Record<string, string>; forced: Record<string, string> };
  clock?: () => Date;
} = {}) => {
  const { calls, exec } = fakeExec(scripts);
  const stepChecks: StepChecks = {
    find: (recipe, stepId) => (recipe === 'pale' && stepId === 'green' ? checks : undefined),
    any: () => true,
  };
  const repos: string[] = [];
  const runner = createCheckRunner({
    state: () => fold(events),
    checks: stepChecks,
    repositoryChecks: (name) => {
      repos.push(name);
      return repo ?? undefined;
    },
    exec,
    env: layers,
    clock,
    platform,
  });
  return { calls, repos, runner };
};

const limits = { outDoc: { file: 'out.md', schema: undefined as never } };

describe('createCheckRunner', () => {
  it("runs the step's checks in order in the attempt's worktree, through the shell, until the deadline", async () => {
    const { calls, repos, runner } = setup({
      checks: ['lint', 'test'],
      scripts: { 'npm test': { output: 'ok 1\n' } },
    });
    const end = await runner.start({ ref, limits }).ended;
    assert.deepEqual(repos, ['acme/api']);
    assert.deepEqual(
      calls.map(({ file, args }) => [file, args]),
      [
        ['npm run lint', []],
        ['npm test', []],
      ],
    );
    for (const { options } of calls) {
      assert.equal(options.cwd, worktree);
      assert.deepEqual(options.env, { PATH: '/usr/bin', npm_config_ignore_scripts: 'true' });
      assert.equal(options.shell, true);
      // On Windows the whole tree goes with a kill, also what a test runner left (ADR 0039).
      assert.equal(options.jobObject, true);
      // Ten seconds short of the deadline: the kill and its grace end before a tick expires it.
      assert.equal(options.timeoutMs, 30 * 60_000 - 10_000);
      assert.ok(options.signal instanceof AbortSignal);
    }
    assert.deepEqual(end, {
      ending: { kind: 'succeeded', output: null },
      readings: [
        { result: 'exited', check: 'lint', command: 'npm run lint', exitCode: 0, tail: '' },
        { result: 'exited', check: 'test', command: 'npm test', exitCode: 0, tail: 'ok 1\n' },
      ],
    });
  });

  it('stops at the first check that fails, and fails the step without a retry', async () => {
    const { calls, runner } = setup({
      checks: ['typecheck', 'test', 'lint'],
      scripts: { 'npm test': { exitCode: 1, output: 'not ok 1\n' } },
    });
    const end = await runner.start({ ref, limits }).ended;
    assert.deepEqual(
      calls.map(({ file }) => file),
      ['npm run typecheck', 'npm test'],
    );
    assert.deepEqual(end.ending, {
      kind: 'failed',
      retryable: false,
      reason: 'the check "test" (npm test) failed with exit code 1',
    });
    assert.deepEqual(end.readings?.at(-1), {
      result: 'exited',
      check: 'test',
      command: 'npm test',
      exitCode: 1,
      tail: 'not ok 1\n',
    });
  });

  it('skips a check the repository has none of, and runs nothing for it', async () => {
    const { calls, runner } = setup({ checks: ['build', 'format'] });
    const end = await runner.start({ ref, limits }).ended;
    assert.deepEqual(calls, []);
    assert.deepEqual(end, {
      ending: { kind: 'succeeded', output: null },
      readings: [
        { result: 'skipped', check: 'build' },
        { result: 'skipped', check: 'format' },
      ],
    });
  });

  it("runs a Brewery's literal command without asking the repository", async () => {
    const { calls, repos, runner } = setup({
      checks: [{ run: 'make e2e', linux: 'make -j e2e' }],
      repo: null,
    });
    const end = await runner.start({ ref, limits }).ended;
    assert.deepEqual(repos, []);
    assert.deepEqual(
      calls.map(({ file }) => file),
      ['make -j e2e'],
    );
    assert.equal(end.ending.kind, 'succeeded');
  });

  it("runs a check in the brewers' environment, a forced variable winning in any case on Windows", async () => {
    // Windows spells PATH as Path in the base.
    const { calls, runner } = setup({
      platform: 'win32',
      layers: {
        base: { Path: 'C:\\bin', SystemRoot: 'C:\\Windows' },
        forced: { PATH: 'C:\\forced', npm_config_ignore_scripts: 'true' },
      },
    });
    await runner.start({ ref, limits }).ended;
    assert.deepEqual(calls[0]?.options.env, {
      PATH: 'C:\\forced',
      SystemRoot: 'C:\\Windows',
      npm_config_ignore_scripts: 'true',
    });
  });

  // A check has the network, outside the sandbox (ADR 0069): claude's login must not reach it.
  it("leaves claude's credentials and settings out of a check's environment", async () => {
    const { calls, runner } = setup({
      layers: {
        base: {
          PATH: '/usr/bin',
          ANTHROPIC_API_KEY: 'sk-ant-key',
          ANTHROPIC_AUTH_TOKEN: 'token',
          CLAUDE_CONFIG_DIR: '/home/ann/.claude',
          CLAUDE_CODE_GIT_BASH_PATH: '/git/bin/bash',
        },
        forced: { npm_config_ignore_scripts: 'true' },
      },
    });
    await runner.start({ ref, limits }).ended;
    assert.deepEqual(calls[0]?.options.env, {
      PATH: '/usr/bin',
      npm_config_ignore_scripts: 'true',
    });
  });

  it('leaves them out in any case on Windows', async () => {
    const { calls, runner } = setup({
      platform: 'win32',
      layers: {
        base: { Path: 'C:\\bin', Anthropic_Api_Key: 'sk-ant-key', claude_config_dir: 'C:\\c' },
        forced: {},
      },
    });
    await runner.start({ ref, limits }).ended;
    assert.deepEqual(calls[0]?.options.env, { Path: 'C:\\bin' });
  });

  it('gives each check only what the checks before it left of the deadline', async () => {
    // Each check takes ten minutes of the step's thirty: the clock moves on with every one run.
    const ran: { calls?: readonly unknown[] } = {};
    const { calls, runner } = setup({
      checks: ['typecheck', 'lint', 'test'],
      clock: () => new Date(now.getTime() + 10 * 60_000 * (ran.calls?.length ?? 0)),
    });
    ran.calls = calls;
    await runner.start({ ref, limits }).ended;
    assert.deepEqual(
      calls.map(({ options }) => options.timeoutMs),
      [30 * 60_000 - 10_000, 20 * 60_000 - 10_000, 10 * 60_000 - 10_000],
    );
  });

  it('gives a check what is left until the deadline, at least a millisecond', async () => {
    const late = [...ordered.slice(0, 2), { ...ordered[2], deadlineAt: now.toISOString() }];
    const { calls, runner } = setup({ events: [...late, started] as Event[] });
    await runner.start({ ref, limits }).ended;
    assert.equal(calls[0]?.options.timeoutMs, 1);
  });

  it('gives a check a millisecond when less than the margin before the deadline is left', async () => {
    const soon = new Date(now.getTime() + 5_000).toISOString();
    const late = [...ordered.slice(0, 2), { ...ordered[2], deadlineAt: soon }];
    const { calls, runner } = setup({ events: [...late, started] as Event[] });
    await runner.start({ ref, limits }).ended;
    assert.equal(calls[0]?.options.timeoutMs, 1);
  });

  it('kills the running check when the engine stops the attempt: it is cancelled', async () => {
    const { runner } = setup({ checks: ['test', 'lint'], scripts: { 'npm test': 'hang' } });
    const running = runner.start({ ref, limits });
    await new Promise((resolve) => setImmediate(resolve));
    running.stop();
    const end = await running.ended;
    assert.deepEqual(end, {
      ending: { kind: 'cancelled' },
      readings: [
        { result: 'killed', check: 'test', command: 'npm test', killed: 'stopped', tail: 'ok 1\n' },
      ],
    });
  });

  it('reports progress while its check runs, so the driver keeps its lease, and none after', async () => {
    const { runner } = setup({ scripts: { 'npm test': 'hang' } });
    assert.equal(runner.progress(ref), undefined);
    const running = runner.start({ ref, limits });
    assert.deepEqual(runner.progress(ref), { lastProgressAt: now, turnsWithoutProgress: 0 });
    assert.equal(runner.progress({ ...ref, attempt: 2 }), undefined);
    running.stop();
    await running.ended;
    assert.equal(runner.progress(ref), undefined);
  });

  it('is blocked by its environment, running nothing, when the attempt has no worktree', async () => {
    const { calls, runner } = setup({
      events: [...ordered, { type: 'step.started', ...ref }],
    });
    const end = await runner.start({ ref, limits }).ended;
    assert.deepEqual(calls, []);
    assert.deepEqual(end, {
      ending: {
        kind: 'blocked',
        blockerKind: 'environment',
        summary: 'attempt green#1 of batch 12-1 has no worktree to read',
      },
    });
  });

  it('is blocked by its environment when the repository lists no checks', async () => {
    const { calls, runner } = setup({ checks: ['test'], repo: null });
    const end = await runner.start({ ref, limits }).ended;
    assert.deepEqual(calls, []);
    assert.deepEqual(end.ending, {
      kind: 'blocked',
      blockerKind: 'environment',
      summary: 'foedrum.jsonc lists no checks of acme/api for the check "test"',
    });
  });

  it("is blocked by a divergence when the step is no check step of the batch's recipe", async () => {
    const other = { ...ref, stepId: 'brew' };
    const { calls, runner } = setup({
      events: [
        ...ordered,
        { type: 'step.scheduled', ...other, deadlineAt },
        { ...started, stepId: 'brew' } as Event,
      ],
    });
    const end = await runner.start({ ref: other, limits }).ended;
    assert.deepEqual(end.ending, {
      kind: 'blocked',
      blockerKind: 'divergence',
      summary: 'recipe pale has no check step brew',
    });
    assert.deepEqual(calls, []);
  });
});
