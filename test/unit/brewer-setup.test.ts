// A repository's setup before a brewer (ADR 0163): the plan of every attempt of a brewer with a
// shell carries its repository's setup, and the brewer runner runs it in the attempt's worktree before claude
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

describe('createAttemptPlans: the setup of a brewer attempt (ADR 0163)', () => {
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
    // A routing deadline apart from the attempt's, so the plan's can only be the attempt's.
    {
      type: 'batch.ordered',
      batchId: '12-1',
      order: { issue: 12 },
      routeBy: '2026-10-17T15:00:00.000Z',
    },
    { type: 'batch.recipe_chosen', batchId: '12-1', recipe: 'pale', reason: 'l', source: 'label' },
    { type: 'step.scheduled', ...ref, deadlineAt },
    started,
  ];
  // A brewer that commits, whose git.commit grants it shell rules of its own (ADR 0074).
  const committingLoaded = loadRecipes({
    recipes: [
      {
        path: 'recipes/pale.jsonc',
        text: recipeText(
          'pale',
          [{ id: 'brew', brewer: 'brewmaster' }, { action: 'openPullRequest' }],
          { testFirst: false },
        ),
      },
    ],
    brewers: [
      {
        path: 'brewers/brewmaster.md',
        text: brewerText('brewmaster', {
          output: { doc: 'brew.md', schema: 'outDoc' },
          produces: 'commits',
          access: 'write',
          git: { commit: true },
        }),
      },
    ],
  });
  assert.ok(committingLoaded.valid);
  const committingBrewers = committingLoaded.brewers;
  const npmCi: RepositorySetup = {
    command: { run: 'npm ci', windows: 'npm.cmd ci' },
    timeout: '10m',
  };
  const plansOf = (
    events: Event[],
    platform: NodeJS.Platform = 'linux',
    setup: RepositorySetup | null = npmCi,
    brewers = loaded.brewers,
    // A shell rule, so the brewer can run what the setup installs (ADR 0163).
    tools: readonly string[] = ['Bash(npm test)'],
  ) =>
    createAttemptPlans({
      state: () => fold(events),
      brewers,
      models: { models: { builder: 'claude-sonnet-5-5' }, brewers: {} },
      repoTools: () => tools,
      repoSetup: (repo) => (repo === 'acme/api' && setup !== null ? setup : undefined),
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

  it('carries it for a brewer that produces commits, beside where its commits are counted', async () => {
    const committing = loadRecipes({
      recipes: [
        {
          path: 'recipes/pale.jsonc',
          text: recipeText(
            'pale',
            [{ id: 'brew', brewer: 'brewmaster' }, { action: 'openPullRequest' }],
            {
              testFirst: false,
            },
          ),
        },
      ],
      brewers: [
        {
          path: 'brewers/brewmaster.md',
          text: brewerText('brewmaster', {
            output: { doc: 'brew.md', schema: 'outDoc' },
            produces: 'commits',
            access: 'write',
            git: { commit: true },
          }),
        },
      ],
    });
    assert.ok(committing.valid, committing.valid ? '' : committing.problems.join('\n'));
    const plan = await plansOf(fresh, 'linux', npmCi, committing.brewers).plan(start);
    assert.equal(plan.setup?.run.command, 'npm ci');
    assert.deepEqual(plan.commits, {
      clone: join('/clones', 'acme/api'),
      branch: 'foedrum/12-1/brew/1',
    });
  });

  // A brewer that cannot run a command cannot use an install, such as a read-only Taster.
  it("carries none for a brewer whose rules and its repository's tools allow no shell (review of #440)", async () => {
    const plan = await plansOf(fresh, 'linux', npmCi, loaded.brewers, []).plan(start);
    assert.deepEqual(plan.permissions.allow, ['Read', 'Grep']);
    assert.equal(plan.setup, undefined);
  });

  it('carries it for a brewer whose repository gives it a PowerShell rule', async () => {
    const tools = ['PowerShell(npm test)'];
    const plan = await plansOf(fresh, 'win32', npmCi, loaded.brewers, tools).plan(start);
    assert.equal(plan.setup?.run.command, 'npm.cmd ci');
  });

  it('carries it for a brewer that commits, through the git rules it is granted, with no repository tools', async () => {
    const plan = await plansOf(fresh, 'linux', npmCi, committingBrewers, []).plan(start);
    assert.ok(plan.permissions.allow.includes('Bash(git commit *)'));
    assert.equal(plan.setup?.run.command, 'npm ci');
  });

  it('carries none for a repository without a setup', async () => {
    const plan = await plansOf(fresh, 'linux', null).plan(start);
    assert.equal(plan.setup, undefined);
  });

  it('carries it for an attempt that resumes a session too: the driver may have re-added its worktree (review of #440)', async () => {
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
    assert.equal(plan.setup?.run.command, 'npm ci');
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
    commits: { clone: '/work/clone', branch: 'foedrum/21-1/plan/1' },
    ...(setup === undefined ? {} : { setup: { run: setup, deadlineAt, env: setupEnv } }),
  });

  type Script = Partial<ExecResult> | 'hang' | { until: Promise<void> };
  /**
   * How the fake claude ends: it succeeds, runs until stopped (after its init line, with
   * `init-then-hang`), throws, or fails before its stream.
   */
  type Claude = 'success' | 'hang' | 'init-then-hang' | 'throws' | 'pre-stream';
  /** A runner whose setup answers as scripted; `order` records the setup and claude's starts. */
  const runnerOf = (
    setup: SetupRun | undefined,
    script: Script = {},
    {
      withExec = true,
      claude = 'success',
      whileCounting,
      now = () => new Date('2026-10-17T12:50:00.000Z'),
    }: {
      withExec?: boolean;
      claude?: Claude;
      whileCounting?: () => void;
      now?: () => Date;
    } = {},
  ) => {
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
      const output = 'until' in script ? 'added 7 packages' : (script.output ?? 'added 7 packages');
      const result = { exitCode: 0, stdout: output, stderr: '', output };
      if ('until' in script) return script.until.then(() => result);
      return Promise.resolve({ ...result, ...script });
    };
    const runner = claudeBrewerRunnerWith({
      claude: '/opt/claude/bin/claude',
      plan: async () => planWith(setup),
      stream: async (_file, _args, options) => {
        order.push('claude');
        if (claude === 'throws') throw new Error('spawn claude ENOENT');
        if (claude === 'pre-stream') return { exitCode: 1, stderr: 'boom' };
        if (claude === 'init-then-hang') options.onLine(success[0] ?? '');
        if (claude === 'hang' || claude === 'init-then-hang') {
          return new Promise((done) =>
            options.signal?.addEventListener('abort', () =>
              done({ exitCode: null, stderr: '', killed: 'stopped' }),
            ),
          );
        }
        for (const line of success) options.onLine(line);
        return { exitCode: 0, stderr: '' };
      },
      ...(withExec ? { setup: exec } : {}),
      files: {
        writeSettings: () => {},
        writeSystemPrompt: () => {},
        readOutDoc: () => ({ kind: 'text', text: outDoc({ status: 'done', summary: 'Planned' }) }),
        clearOutDoc: () => {},
        restoreOutDoc: () => {},
        copyOutDoc: () => {},
      },
      // By default ten minutes before the attempt's deadline.
      now,
      // The wait before a second start of claude lasts until the attempt is stopped.
      wait: (_ms, signal) =>
        claude === 'pre-stream'
          ? new Promise<void>((done) => signal.addEventListener('abort', () => done()))
          : Promise.resolve(),
      commits: async () => {
        whileCounting?.();
        return { kind: 'counted', count: 1 };
      },
      scan: async () => ({ kind: 'scanned', findings: [] }),
      touches: async (_clone, _commit, paths) => ({ kind: 'read', present: new Set(paths) }),
    });
    return { runner, order, setups };
  };
  const passed = [
    { result: 'exited', setup: true, command: 'npm ci', exitCode: 0, tail: 'added 7 packages' },
  ];

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
    const { runner, order } = runnerOf(run, {}, { withExec: false });
    const end = await runner.start(attempt).ended;
    assert.deepEqual(order, []);
    const why = 'the brewer runner has no process runner for setups';
    assert.deepEqual(end.ending, {
      kind: 'blocked',
      blockerKind: 'environment',
      summary: `the setup "npm ci" could not start: ${why}`,
    });
    assert.deepEqual(end.readings, [
      { result: 'unstarted', setup: true, command: 'npm ci', tail: why },
    ]);
  });

  // Review of #459: an incomplete receipt measures claude, from its start after the setup.
  it("measures an incomplete receipt from claude's start, after the setup", async () => {
    let clock = new Date('2026-10-17T12:00:00.000Z');
    let setUp = (): void => {};
    const { runner } = runnerOf(
      run,
      { until: new Promise<void>((done) => (setUp = done)) },
      { claude: 'init-then-hang', now: () => clock },
    );
    const running = runner.start(attempt);
    await new Promise((resolve) => setImmediate(resolve));
    // The setup took five minutes, and claude's init comes as it starts: from the attempt's start
    // the receipt would count those five minutes.
    clock = new Date('2026-10-17T12:05:00.000Z');
    setUp();
    await new Promise((resolve) => setImmediate(resolve));
    running.stop();
    const end = await running.ended;
    assert.equal(end.receipt?.complete, false);
    assert.equal(end.receipt?.durationMs, 0);
  });

  it("keeps the setup's reading when claude cannot start after it", async () => {
    const { runner, order } = runnerOf(run, {}, { claude: 'throws' });
    const end = await runner.start(attempt).ended;
    assert.deepEqual(order, ['setup', 'claude']);
    assert.equal(end.ending.kind, 'failed');
    assert.deepEqual(end.readings, passed);
  });

  it("keeps the setup's reading when the attempt is stopped while claude runs", async () => {
    const { runner } = runnerOf(run, {}, { claude: 'hang' });
    const running = runner.start(attempt);
    await new Promise((resolve) => setImmediate(resolve));
    running.stop();
    const end = await running.ended;
    assert.equal(end.ending.kind, 'cancelled');
    assert.deepEqual(end.readings, passed);
  });

  it("keeps the setup's reading when the attempt is stopped while it waits to start claude again", async () => {
    const { runner, order } = runnerOf(run, {}, { claude: 'pre-stream' });
    const running = runner.start(attempt);
    await new Promise((resolve) => setImmediate(resolve));
    running.stop();
    const end = await running.ended;
    assert.deepEqual(order, ['setup', 'claude']);
    assert.equal(end.ending.kind, 'cancelled');
    assert.deepEqual(end.readings, passed);
  });

  it("keeps the setup's reading when the attempt is stopped while its commits are counted", async () => {
    let stop = () => {};
    const { runner } = runnerOf(run, {}, { whileCounting: () => stop() });
    const running = runner.start({
      ...attempt,
      limits: { ...limits, commitsSince: 'c'.repeat(40) },
    });
    stop = running.stop;
    const end = await running.ended;
    assert.equal(end.ending.kind, 'cancelled');
    assert.deepEqual(end.readings, passed);
  });

  // The stall limit judges the brewer, not its repository's install (ADR 0027, review of #440).
  it("does not count the setup's time against the brewer's stall limit", async () => {
    let time = Date.parse('2026-10-17T12:00:00.000Z');
    let finish = () => {};
    const until = new Promise<void>((done) => {
      finish = done;
    });
    const { runner } = runnerOf(run, { until }, { claude: 'hang', now: () => new Date(time) });
    const running = runner.start(attempt);
    await new Promise((resolve) => setImmediate(resolve));
    // Twenty minutes into the setup, the attempt still progresses.
    time += 20 * 60_000;
    assert.deepEqual(runner.progress(attempt.ref)?.lastProgressAt, new Date(time));
    finish();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    // claude started when the setup ended: its stall clock starts there, not at the attempt's start.
    const ready = new Date(time);
    time += 60_000;
    assert.deepEqual(runner.progress(attempt.ref)?.lastProgressAt, ready);
    running.stop();
    await running.ended;
  });
});
