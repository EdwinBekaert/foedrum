// The brewer runner of `foedrum resume` on a running batch (ADR 0127), with a fake foreground
// claude, fake files and a fake headless runner: a resumed attempt opens claude --resume in its
// worktree with its settings and environment and ends by the out doc the session wrote; a fresh
// one runs headless. No process starts (ADR 0021).

import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { attemptSettings } from '../../src/brewers/attempt-settings.ts';
import { resumeArgs } from '../../src/brewers/claude-command.ts';
import type { ClaudeAttemptPlan, OutDocRead } from '../../src/brewers/claude-runner.ts';
import {
  headlessRunner,
  type InteractiveRunnerDeps,
  interactiveBrewerRunnerWith,
} from '../../src/brewers/interactive-runner.ts';
import { assembleBrewerPrompt } from '../../src/brewers/prompt.ts';
import type { AttemptLimits, AttemptStart, BrewerRunner } from '../../src/engine/brewer-runner.ts';
import type { ExecProcess } from '../../src/platform/processes.ts';
import { OutDocFrontmatter } from '../../src/schemas/out-doc.ts';
import { outDoc } from '../helpers/fake-brewer-runner.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';

const t0 = new Date('2026-10-23T12:00:00.000Z');
const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
const assembled = assembleBrewerPrompt('Brew the order.', []);
if (assembled.kind !== 'assembled') throw new Error('the test prompt was refused');

const limits: AttemptLimits = {
  outDoc: { file: 'brew.md', schema: OutDocFrontmatter },
  commitsSince: 'a'.repeat(40),
};
const attempt: AttemptStart = { ref: { batchId: '12-1', stepId: 'brew', attempt: 2 }, limits };
const plan = (kind: 'new' | 'resume'): ClaudeAttemptPlan => ({
  cwd: resolve('work', 'tree'),
  env: { PATH: '/usr/bin', GIT_TERMINAL_PROMPT: '0' },
  prompt: assembled.prompt,
  call: {
    model: 'claude-haiku-5-5',
    effort: 'low',
    tools: ['Read', 'Write'],
    session: { kind, id },
  },
  permissions: { allow: ['Read', 'Write'], deny: [], sandbox: false },
  settingsFile: resolve('work', 'settings.json'),
  commits: { clone: resolve('clone'), branch: 'foedrum/12-1/brew/1' },
});

describe('interactiveBrewerRunnerWith (ADR 0127)', () => {
  let calls: string[];
  let foreground: { program: string; args: readonly string[]; cwd: string; env: object }[];
  let written: OutDocRead;
  let headlessPlans: ClaudeAttemptPlan[];
  /** The headless runs that were stopped; with `hangs`, a headless run ends only when stopped. */
  let headlessStops: number;
  let hangs: boolean;

  beforeEach(() => {
    calls = [];
    foreground = [];
    written = { kind: 'text', text: outDoc({ status: 'done', summary: 'Brewed by hand' }) };
    headlessPlans = [];
    headlessStops = 0;
    hangs = false;
  });

  const runner = (
    kind: 'new' | 'resume',
    overrides: Partial<InteractiveRunnerDeps> = {},
  ): BrewerRunner =>
    interactiveBrewerRunnerWith({
      claude: '/bin/claude',
      plan: async () => plan(kind),
      headless: (planOf) => ({
        start: (started) => {
          const end = { ending: { kind: 'failed', retryable: true, reason: 'headless' } } as const;
          let settle: () => void = () => {};
          const stopped = new Promise<typeof end>((resolve) => {
            settle = () => resolve(end);
          });
          return {
            ended: planOf(started).then((planned) => {
              headlessPlans.push(planned);
              return hangs ? stopped : end;
            }),
            stop: () => {
              headlessStops++;
              settle();
            },
          };
        },
        progress: () => ({ lastProgressAt: t0, turnsWithoutProgress: 7 }),
      }),
      foreground: async (program, args, cwd, env) => {
        calls.push('claude');
        foreground.push({ program, args, cwd, env });
        return 0;
      },
      terminalEnv: { TERM: 'xterm-256color' },
      platform: 'linux',
      files: {
        writeSettings: (file, settings) => {
          calls.push(`settings ${file} ${JSON.stringify(settings)}`);
        },
        writeSystemPrompt: (file, text) => {
          calls.push(`system prompt ${file} ${JSON.stringify(text)}`);
        },
        readOutDoc: (file, _max, root) => {
          calls.push(`read ${file} in ${root}`);
          return written;
        },
        clearOutDoc: (file, root) => {
          calls.push(`clear ${file} in ${root}`);
        },
      },
      commits: async () => ({ kind: 'counted', count: 1 }),
      now: () => t0,
      say: (line) => calls.push(`say ${line}`),
      ...overrides,
    });

  it("opens the resumed session in the foreground in its worktree, with the attempt's guards and environment", async () => {
    const { ending, outDoc: text } = await runner('resume').start(attempt).ended;
    const resumed = plan('resume');
    const outFile = resolve(resumed.cwd, 'brew.md');
    assert.deepEqual(calls, [
      `settings ${resumed.settingsFile} ${JSON.stringify(attemptSettings(resumed.permissions))}`,
      `clear ${outFile} in ${resumed.cwd}`,
      `say foedrum resume: opening session ${id} of 12-1 brew#2 in ${resumed.cwd}: finish the step, have the session write brew.md as the brewer's instructions say, then exit claude; the batch goes on from its next step`,
      'claude',
      `read ${outFile} in ${resumed.cwd}`,
    ]);
    assert.deepEqual(foreground, [
      {
        program: '/bin/claude',
        args: resumeArgs({
          model: 'claude-haiku-5-5',
          effort: 'low',
          settingsFile: resumed.settingsFile,
          tools: ['Read', 'Write'],
          sessionId: id,
        }),
        cwd: resumed.cwd,
        env: { PATH: '/usr/bin', GIT_TERMINAL_PROMPT: '0', TERM: 'xterm-256color' },
      },
    ]);
    assert.equal(ending.kind, 'succeeded');
    assert.equal(text, (written as { text: string }).text);
  });

  // ADR 0183: the takeover keeps the engine's rules, for the requests after a compaction too.
  it("writes the attempt's system prompt file after its settings and passes it to the session", async () => {
    const systemPrompt = { file: resolve('work', 'settings.system.md'), text: '- Do not push.\n' };
    const resumed = { ...plan('resume'), systemPrompt };
    await runner('resume', { plan: async () => resumed }).start(attempt).ended;
    const settingsAt = calls.findIndex((call) => call.startsWith('settings '));
    assert.equal(
      calls[settingsAt + 1],
      `system prompt ${systemPrompt.file} ${JSON.stringify(systemPrompt.text)}`,
    );
    assert.deepEqual(
      foreground.map(({ args }) => args),
      [
        resumeArgs({
          model: 'claude-haiku-5-5',
          effort: 'low',
          settingsFile: resumed.settingsFile,
          tools: ['Read', 'Write'],
          sessionId: id,
          appendSystemPromptFile: systemPrompt.file,
        }),
      ],
    );
  });

  it('ends by the out doc the session wrote, as any run: none is a retryable failure', async () => {
    written = { kind: 'missing' };
    const { ending } = await runner('resume').start(attempt).ended;
    assert.deepEqual(ending, {
      kind: 'failed',
      retryable: true,
      reason: 'the out doc brew.md is missing',
    });
  });

  it('needs a commit after the start of a brewer that produces commits, as any run', async () => {
    const none = runner('resume', { commits: async () => ({ kind: 'counted', count: 0 }) });
    const { ending } = await none.start(attempt).ended;
    assert.equal(ending.kind, 'blocked');
  });

  it("is a failure that names claude's exit code when the session ends with one", async () => {
    const { ending } = await runner('resume', { foreground: async () => 3 }).start(attempt).ended;
    assert.deepEqual(ending, {
      kind: 'failed',
      retryable: true,
      reason: 'the brewer process exited with code 3',
    });
  });

  it('does not start claude when the settings cannot be written', async () => {
    const files = {
      writeSettings: () => {
        throw new Error('EACCES');
      },
      writeSystemPrompt: () => {},
      readOutDoc: () => written,
      clearOutDoc: () => {},
    };
    const { ending } = await runner('resume', { files }).start(attempt).ended;
    assert.deepEqual(ending, {
      kind: 'failed',
      retryable: false,
      reason: 'the brewer could not start: EACCES',
    });
    assert.deepEqual(foreground, []);
  });

  it('reports progress while the session is open, so its lease is renewed and it never stalls, and leaves it open on a stop', async () => {
    let close: (code: number) => void = () => {};
    const open = runner('resume', {
      foreground: () =>
        new Promise((settle) => {
          close = settle;
        }),
    });
    const run = open.start(attempt);
    await new Promise((settle) => setImmediate(settle));
    assert.deepEqual(open.progress(attempt.ref), { lastProgressAt: t0, turnsWithoutProgress: 0 });
    run.stop();
    close(0);
    const { ending } = await run.ended;
    assert.equal(ending.kind, 'succeeded', "the session is the engineer's: a stop does not end it");
    assert.equal(open.progress(attempt.ref), undefined);
  });

  it("gives the brewer's own variables before the terminal's, by name as the platform reads them", async () => {
    const brewerLang = (name: string): ClaudeAttemptPlan => ({
      ...plan('resume'),
      env: { PATH: '/usr/bin', [name]: 'C.UTF-8' },
    });
    await runner('resume', {
      plan: async () => brewerLang('LANG'),
      terminalEnv: { TERM: 'xterm-256color', LANG: 'de_DE.UTF-8' },
    }).start(attempt).ended;
    // On Windows a name is one variable in any case: the brewer's spelling and value stay.
    await runner('resume', {
      plan: async () => brewerLang('Lang'),
      terminalEnv: { TERM: 'xterm-256color', LANG: 'de_DE.UTF-8' },
      platform: 'win32',
    }).start(attempt).ended;
    assert.deepEqual(
      foreground.map(({ env }) => env),
      [
        { TERM: 'xterm-256color', LANG: 'C.UTF-8', PATH: '/usr/bin' },
        { TERM: 'xterm-256color', Lang: 'C.UTF-8', PATH: '/usr/bin' },
      ],
    );
  });

  it('says the commits were not counted when the plan names no clone, or git fails', async () => {
    const { commits: _, ...cloneless } = plan('resume');
    const none = await runner('resume', { plan: async () => cloneless }).start(attempt).ended;
    const failing = runner('resume', { commits: () => Promise.reject(new Error('git broke')) });
    const broke = await failing.start(attempt).ended;
    const start = 'a'.repeat(7);
    assert.deepEqual(
      [none.ending, broke.ending],
      [
        {
          kind: 'blocked',
          blockerKind: 'environment',
          summary: `the commits since ${start} were not counted: the plan names no clone to count them in`,
        },
        {
          kind: 'blocked',
          blockerKind: 'environment',
          summary: `the commits since ${start} were not counted: git broke`,
        },
      ],
    );
  });

  it('ends an attempt whose claude cannot start as unstartable, and reads no out doc', async () => {
    const broken = runner('resume', {
      foreground: () => Promise.reject(new Error('spawn ENOENT')),
    });
    const { ending } = await broken.start(attempt).ended;
    assert.deepEqual(ending, {
      kind: 'failed',
      retryable: false,
      reason: 'the brewer could not start: spawn ENOENT',
    });
    assert.ok(!calls.some((call) => call.startsWith('read ')));
  });

  it('passes a stop and the progress of an attempt that starts fresh on to its headless run', async () => {
    hangs = true;
    const fresh = runner('new');
    const run = fresh.start(attempt);
    await new Promise((settle) => setImmediate(settle));
    assert.deepEqual(fresh.progress(attempt.ref), { lastProgressAt: t0, turnsWithoutProgress: 7 });
    run.stop();
    await run.ended;
    assert.equal(headlessStops, 1);
  });

  it('stops a fresh attempt stopped before its plan came, once its headless run starts', async () => {
    hangs = true;
    let planned: (value: ClaudeAttemptPlan) => void = () => {};
    const slow = runner('new', {
      plan: () =>
        new Promise((settle) => {
          planned = settle;
        }),
    });
    const run = slow.start(attempt);
    run.stop();
    planned(plan('new'));
    await run.ended;
    assert.equal(headlessStops, 1);
  });

  it('runs an attempt that starts fresh headless, with its plan, and opens nothing', async () => {
    const { ending } = await runner('new').start(attempt).ended;
    assert.deepEqual(ending, { kind: 'failed', retryable: true, reason: 'headless' });
    assert.deepEqual(headlessPlans, [plan('new')]);
    assert.deepEqual(foreground, []);
  });

  // The worktree of a resumed session may have been re-added without its install (review of #440).
  describe("a resumed session's setup (ADR 0163)", () => {
    const withSetup = async (): Promise<ClaudeAttemptPlan> => ({
      ...plan('resume'),
      setup: {
        run: { command: 'npm ci', timeoutMs: 600_000, unsandboxed: false },
        deadlineAt: '2026-10-23T13:00:00.000Z',
        env: { PATH: '/usr/bin' },
      },
    });
    const setupExec =
      (exitCode: number): ExecProcess =>
      async (file, _args, options) => {
        calls.push(`setup ${file} in ${options.cwd}`);
        const output = exitCode === 0 ? 'added 7 packages' : 'npm ERR! missing lock file';
        return { exitCode, stdout: output, stderr: '', output };
      };

    it('runs the setup in the worktree before it opens the session, and records its reading', async () => {
      const end = await runner('resume', { plan: withSetup, setup: setupExec(0) }).start(attempt)
        .ended;
      const ran = calls.indexOf(`setup npm ci in ${plan('resume').cwd}`);
      assert.ok(ran !== -1 && ran < calls.indexOf('claude'), calls.join('\n'));
      assert.equal(end.ending.kind, 'succeeded');
      assert.deepEqual(end.readings, [
        { result: 'exited', setup: true, command: 'npm ci', exitCode: 0, tail: 'added 7 packages' },
      ]);
    });

    it('ends blocked on its environment, without opening the session, when the setup fails', async () => {
      const end = await runner('resume', { plan: withSetup, setup: setupExec(1) }).start(attempt)
        .ended;
      assert.ok(!calls.includes('claude'), calls.join('\n'));
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
    });

    it('ends cancelled, without opening the session, when the attempt is stopped during the setup', async () => {
      let signal: AbortSignal | undefined;
      let finish = () => {};
      const hanging: ExecProcess = (file, _args, options) => {
        calls.push(`setup ${file}`);
        signal = options.signal;
        return new Promise((done) => {
          const stopped = () =>
            done({ exitCode: null, stdout: '', stderr: '', output: '', killed: 'stopped' });
          finish = stopped;
          options.signal?.addEventListener('abort', stopped);
        });
      };
      const running = runner('resume', { plan: withSetup, setup: hanging }).start(attempt);
      await new Promise((resolve) => setImmediate(resolve));
      running.stop();
      const reached = signal?.aborted === true;
      // Else the process runner ends it at its timeout.
      finish();
      const end = await running.ended;
      assert.equal(reached, true, 'the stop reaches the setup');
      assert.ok(!calls.includes('claude'), calls.join('\n'));
      assert.equal(end.ending.kind, 'cancelled');
    });

    it('reports progress while the setup runs, so the lease of the session is renewed', async () => {
      let finish = () => {};
      const until = new Promise<void>((done) => {
        finish = done;
      });
      const slow: ExecProcess = async (file) => {
        calls.push(`setup ${file}`);
        await until;
        return { exitCode: 0, stdout: '', stderr: '', output: 'added 7 packages' };
      };
      const resumed = runner('resume', { plan: withSetup, setup: slow });
      const running = resumed.start(attempt);
      await new Promise((resolve) => setImmediate(resolve));
      assert.ok(calls.includes('setup npm ci'), calls.join('\n'));
      assert.deepEqual(resumed.progress(attempt.ref), {
        lastProgressAt: t0,
        turnsWithoutProgress: 0,
      });
      finish();
      await running.ended;
    });

    it("keeps the setup's reading when claude cannot open after it", async () => {
      const end = await runner('resume', {
        plan: withSetup,
        setup: setupExec(0),
        foreground: async () => {
          throw new Error('spawn claude ENOENT');
        },
      }).start(attempt).ended;
      assert.equal(end.ending.kind, 'failed');
      assert.deepEqual(end.readings, [
        { result: 'exited', setup: true, command: 'npm ci', exitCode: 0, tail: 'added 7 packages' },
      ]);
    });
  });

  describe('headlessRunner: a fresh attempt of a resume (ADR 0163)', () => {
    let dir: TempDir;
    beforeEach(() => {
      dir = makeTempDir('headless-setup');
    });
    afterEach(() => dir.remove());

    it("runs the fresh attempt's setup through the given process runner, before claude", async () => {
      const started: string[] = [];
      const failing: ExecProcess = async (file) => {
        started.push(file);
        // A setup that fails, so claude never starts.
        return { exitCode: 1, stdout: '', stderr: '', output: 'npm ERR!' };
      };
      const fresh = async (): Promise<ClaudeAttemptPlan> => ({
        ...plan('new'),
        settingsFile: join(dir.path, 'settings.json'),
        setup: {
          run: { command: 'npm ci', timeoutMs: 600_000, unsandboxed: false },
          deadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
          env: { PATH: '/usr/bin' },
        },
      });
      const end = await headlessRunner('/opt/claude/bin/claude', failing)(fresh).start(attempt)
        .ended;
      assert.deepEqual(started, ['npm ci']);
      assert.deepEqual(end.ending, {
        kind: 'blocked',
        blockerKind: 'environment',
        summary: 'the setup "npm ci" failed with exit code 1',
      });
    });
  });
});
