// A repository's setup before a brewer (ADR 0163): the plan of an attempt that starts fresh carries
// its repository's setup, and the brewer runner runs it in the attempt's worktree before claude
// starts, through the setup's process runner; a setup that does not pass ends the attempt blocked
// on its environment, before any model tokens (ADR 0021: fake process runners and files).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createAttemptPlans } from '../../src/brewers/attempt-plans.ts';
import { type ClaudeAttemptPlan, claudeBrewerRunnerWith } from '../../src/brewers/claude-runner.ts';
import { assembleBrewerPrompt } from '../../src/brewers/prompt.ts';
import type { SetupRun } from '../../src/checks/setup.ts';
import type { AttemptStart } from '../../src/engine/brewer-runner.ts';
import { fold } from '../../src/engine/fold.ts';
import { loadRecipes } from '../../src/engine/recipe-files.ts';
import type { ExecOptions, ExecProcess, ExecResult } from '../../src/platform/processes.ts';
import type { RepositorySetup } from '../../src/schemas/brewery-config.ts';
import type { Event } from '../../src/schemas/events.ts';
import { OutDocFrontmatter } from '../../src/schemas/out-doc.ts';
import { brewerText, recipeText } from '../helpers/brewery-files.ts';
import { outDoc } from '../helpers/fake-brewer-runner.ts';

const worktree = join('/work', 'brew-1');
const sessionId = '0f8fad5b-d9cb-469f-a165-70867728950e';
const ref = { batchId: '12-1', stepId: 'brew', attempt: 1 };
const deadlineAt = '2026-10-17T13:00:00.000Z';

describe('createAttemptPlans: the setup of a fresh attempt (ADR 0163)', () => {
  const loaded = loadRecipes({
    recipes: [
      {
        path: 'recipes/pale.jsonc',
        text: recipeText('pale', [{ id: 'brew', brewer: 'brewmaster' }]),
      },
    ],
    brewers: [
      {
        path: 'brewers/brewmaster.md',
        text: brewerText('brewmaster', { output: { doc: 'brew.md', schema: 'outDoc' } }),
      },
    ],
  });
  assert.ok(loaded.valid);
  const started: Event = {
    type: 'step.started',
    ...ref,
    session: { id: sessionId, worktree },
    worktree: {
      repo: 'acme/api',
      path: worktree,
      branch: 'foedrum/12-1/brew/1',
      commit: 'c'.repeat(40),
    },
  };
  const fresh: Event[] = [
    { type: 'batch.ordered', batchId: '12-1', order: { issue: 12 }, routeBy: deadlineAt },
    { type: 'batch.recipe_chosen', batchId: '12-1', recipe: 'pale', reason: 'l', source: 'label' },
    { type: 'step.scheduled', ...ref, deadlineAt },
    started,
  ];
  const npmCi: RepositorySetup = {
    command: { run: 'npm ci', windows: 'npm.cmd ci' },
    timeout: '10m',
  };
  const plansOf = (
    events: Event[],
    platform: NodeJS.Platform = 'linux',
    setup: RepositorySetup | undefined = npmCi,
  ) =>
    createAttemptPlans({
      state: () => fold(events),
      brewers: loaded.brewers,
      models: { models: { builder: 'claude-sonnet-5-5' }, brewers: {} },
      repoTools: () => [],
      repoSetup: (repo) => (repo === 'acme/api' ? setup : undefined),
      clone: (repo) => join('/clones', repo),
      sandbox: false,
      workRoot: join('/root'),
      env: {
        base: { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk-test', CLAUDE_CONFIG_DIR: '/c' },
        forced: { npm_config_ignore_scripts: 'true' },
      },
      platform,
      orderText: async () => 'Add a --json flag.',
      files: {
        read: () => ({ kind: 'text', text: '# Guide' }),
        makeFolder: () => {},
      },
    });
  const start = { ref, limits: { outDoc: { file: 'brew.md', schema: OutDocFrontmatter } } };

  it("carries its repository's setup for the platform, the attempt's deadline and the checks' environment", async () => {
    const plan = await plansOf(fresh).plan(start);
    assert.deepEqual(plan.setup?.run, {
      command: 'npm ci',
      timeoutMs: 600_000,
      unsandboxed: false,
    });
    assert.equal(plan.setup?.deadlineAt, deadlineAt);
    const env = plan.setup?.env ?? {};
    assert.equal(env.PATH, '/usr/bin');
    assert.equal(env.npm_config_ignore_scripts, 'true');
    // claude's login is claude's alone, as for a check (ADR 0069).
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(env.CLAUDE_CONFIG_DIR, undefined);
  });

  it('runs it unsandboxed on native Windows, with its Windows command line, and says so', async () => {
    const plan = await plansOf(fresh, 'win32').plan(start);
    assert.deepEqual(plan.setup?.run, {
      command: 'npm.cmd ci',
      timeoutMs: 600_000,
      unsandboxed: true,
    });
  });

  it('carries none for a repository without a setup', async () => {
    const plan = await plansOf(fresh, 'linux', undefined).plan(start);
    assert.equal(plan.setup, undefined);
  });

  it('carries none for an attempt that resumes a session: its worktree was set up when the session started', async () => {
    const second = { ...ref, attempt: 2 };
    const events: Event[] = [
      ...fresh,
      {
        type: 'step.finished',
        ...ref,
        outcome: { kind: 'failed', retryable: true, reason: 'claude crashed' },
        claude: { version: '2.1.301', model: 'claude-sonnet-5-5' },
      },
      { type: 'step.scheduled', ...second, deadlineAt, retry: true },
      {
        type: 'step.started',
        ...second,
        session: { id: sessionId, resumes: sessionId, worktree },
      },
    ];
    const plan = await plansOf(events).plan({ ...start, ref: second });
    assert.equal(plan.call.session.kind, 'resume');
    assert.equal(plan.setup, undefined);
  });
});

describe('claudeBrewerRunner: the setup before claude (ADR 0163)', () => {
  const success = readFileSync(
    join(import.meta.dirname, '..', 'fixtures', 'claude-stream', 'success.jsonl'),
    'utf8',
  )
    .split('\n')
    .filter((line) => line !== '');
  const assembled = assembleBrewerPrompt('Plan the change.', []);
  if (assembled.kind !== 'assembled') throw new Error('the test prompt was refused');
  const limits = { outDoc: { file: 'plan.md', schema: OutDocFrontmatter }, maxTurns: 3 };
  const attempt: AttemptStart = { ref: { batchId: '21-1', stepId: 'plan', attempt: 1 }, limits };
  const run: SetupRun = { command: 'npm ci', timeoutMs: 600_000, unsandboxed: false };
  const setupEnv = { PATH: '/usr/bin', npm_config_ignore_scripts: 'true' };
  const planWith = (setup?: SetupRun): ClaudeAttemptPlan => ({
    cwd: '/work/tree',
    env: { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk-test' },
    prompt: assembled.prompt,
    call: {
      model: 'claude-haiku-5-5',
      effort: 'low',
      maxTurns: 3,
      tools: ['Read'],
      // The fixture's session id.
      session: { kind: 'new', id: '00000000-0000-4000-8000-000000000001' },
    },
    permissions: { allow: ['Read'], deny: [], sandbox: false },
    settingsFile: '/work/attempt/settings.json',
    ...(setup === undefined ? {} : { setup: { run: setup, deadlineAt, env: setupEnv } }),
  });

  type Script = Partial<ExecResult> | 'hang';
  /** A runner whose setup answers as scripted; `order` records the setup and claude's starts. */
  const runnerOf = (setup: SetupRun | undefined, script: Script = {}, withExec = true) => {
    const order: string[] = [];
    const setups: { file: string; options: ExecOptions }[] = [];
    const exec: ExecProcess = (file, _args, options) => {
      setups.push({ file, options });
      order.push('setup');
      if (script === 'hang') {
        return new Promise((done) =>
          options.signal?.addEventListener('abort', () =>
            done({ exitCode: null, stdout: '', stderr: '', output: '', killed: 'stopped' }),
          ),
        );
      }
      const output = script.output ?? 'added 7 packages';
      return Promise.resolve({ exitCode: 0, stdout: output, stderr: '', output, ...script });
    };
    const runner = claudeBrewerRunnerWith({
      claude: '/opt/claude/bin/claude',
      plan: async () => planWith(setup),
      stream: async (_file, _args, options) => {
        order.push('claude');
        for (const line of success) options.onLine(line);
        return { exitCode: 0, stderr: '' };
      },
      ...(withExec ? { setup: exec } : {}),
      files: {
        writeSettings: () => {},
        readOutDoc: () => ({ kind: 'text', text: outDoc({ status: 'done', summary: 'Planned' }) }),
        clearOutDoc: () => {},
      },
      // Ten minutes before the attempt's deadline.
      now: () => new Date('2026-10-17T12:50:00.000Z'),
      wait: async () => {},
      commits: async () => ({ kind: 'counted', count: 1 }),
    });
    return { runner, order, setups };
  };

  it("runs the setup in the worktree before claude starts, through the setup's runner, and records its reading", async () => {
    const { runner, order, setups } = runnerOf(run);
    const end = await runner.start(attempt).ended;
    assert.deepEqual(order, ['setup', 'claude']);
    const [call] = setups;
    assert.equal(call?.file, 'npm ci');
    assert.equal(call?.options.cwd, '/work/tree');
    assert.deepEqual(call?.options.env, setupEnv);
    assert.equal(call?.options.shell, true);
    assert.equal(call?.options.jobObject, true);
    assert.equal(end.ending.kind, 'succeeded');
    assert.deepEqual(end.readings, [
      { result: 'exited', setup: true, command: 'npm ci', exitCode: 0, tail: 'added 7 packages' },
    ]);
  });

  it("kills the setup at its timeout, or 10 s before the attempt's deadline when that is sooner", async () => {
    const { runner, setups } = runnerOf({ ...run, timeoutMs: 60_000 });
    await runner.start(attempt).ended;
    assert.equal(setups[0]?.options.timeoutMs, 60_000);
    const late = runnerOf(run);
    await late.runner.start(attempt).ended;
    // Ten minutes left, less the kill's margin.
    assert.equal(late.setups[0]?.options.timeoutMs, 590_000);
  });

  it('ends the attempt blocked on its environment when the setup fails, and never starts claude', async () => {
    const { runner, order } = runnerOf(run, { exitCode: 1, output: 'npm ERR! missing lock file' });
    const end = await runner.start(attempt).ended;
    assert.deepEqual(order, ['setup']);
    assert.deepEqual(end.ending, {
      kind: 'blocked',
      blockerKind: 'environment',
      summary: 'the setup "npm ci" failed with exit code 1',
    });
    assert.deepEqual(end.readings, [
      {
        result: 'exited',
        setup: true,
        command: 'npm ci',
        exitCode: 1,
        tail: 'npm ERR! missing lock file',
      },
    ]);
    assert.equal(end.usage, undefined);
  });

  it('ends the attempt blocked when the setup cannot start, as in a sandbox that does not start', async () => {
    const { runner, order } = runnerOf(run, { exitCode: null, output: 'bwrap: not found' });
    const end = await runner.start(attempt).ended;
    assert.deepEqual(order, ['setup']);
    assert.deepEqual(end.ending, {
      kind: 'blocked',
      blockerKind: 'environment',
      summary: 'the setup "npm ci" could not start: bwrap: not found',
    });
  });

  it('says a setup ran unsandboxed on native Windows', async () => {
    const { runner } = runnerOf({ ...run, unsandboxed: true });
    const end = await runner.start(attempt).ended;
    assert.deepEqual(
      end.readings?.map((reading) => 'unsandboxed' in reading && reading.unsandboxed),
      [true],
    );
  });

  it('ends cancelled when the attempt is stopped during the setup, and never starts claude', async () => {
    const { runner, order } = runnerOf(run, 'hang');
    const running = runner.start(attempt);
    await new Promise((resolve) => setImmediate(resolve));
    running.stop();
    const end = await running.ended;
    assert.deepEqual(order, ['setup']);
    assert.equal(end.ending.kind, 'cancelled');
  });

  it('is blocked on its environment when the plan has a setup and the runner none to run it through', async () => {
    const { runner, order } = runnerOf(run, {}, false);
    const end = await runner.start(attempt).ended;
    assert.deepEqual(order, []);
    assert.equal(end.ending.kind, 'blocked');
  });
});
