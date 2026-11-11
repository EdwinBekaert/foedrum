// The checks before a brewer's end in the real brewer runner's shell (ADR 0381), with a fake stream
// process that plays the captured streams of #17 and a fake check process: a failure goes back to
// the same session once, with `--resume`, and the second end is the attempt's.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { claudeArgs } from '../../src/brewers/claude-command.ts';
import {
  type ClaudeAttemptPlan,
  type ClaudeRunnerDeps,
  claudeBrewerRunnerWith,
} from '../../src/brewers/claude-runner.ts';
import { readClaudeStream } from '../../src/brewers/claude-stream.ts';
import { assembleBrewerPrompt } from '../../src/brewers/prompt.ts';
import type { SendBackPlan } from '../../src/brewers/send-back.ts';
import type { AttemptLimits, AttemptStart, CommitsSeen } from '../../src/engine/brewer-runner.ts';
import type {
  ExecOptions,
  ExecResult,
  StreamOptions,
  StreamResult,
} from '../../src/platform/processes.ts';
import { OutDocFrontmatter } from '../../src/schemas/out-doc.ts';
import type { PathsChanged } from '../../src/workspace/attempt-commits-git.ts';
import { outDoc } from '../helpers/fake-brewer-runner.ts';

const fixtures = join(import.meta.dirname, '..', 'fixtures', 'claude-stream');
const fixture = (file: string): string[] =>
  readFileSync(join(fixtures, file), 'utf8')
    .split('\n')
    .filter((line) => line !== '');

// resumed.jsonl resumes the session of success.jsonl (the fixtures' manifest).
const sessionId = '00000000-0000-4000-8000-000000000001';
const start = 'c'.repeat(40);

const assembled = assembleBrewerPrompt('Make the tests pass.', []);
if (assembled.kind !== 'assembled') throw new Error('the test prompt was refused');

const limits: AttemptLimits = {
  outDoc: { file: 'brew.md', schema: OutDocFrontmatter },
  maxTurns: 3,
  commitsSince: start,
};
const attempt: AttemptStart = {
  ref: { batchId: '21-1', stepId: 'implement', attempt: 1 },
  limits,
};

const sendBack: SendBackPlan = {
  checks: [
    { check: 'typecheck', command: 'tsc', files: false },
    { check: 'lint', command: 'biome lint', files: true },
    { check: 'test', command: 'node --test', files: true },
  ],
  redTests: ['test/a.test.ts'],
  deadlineAt: '2026-10-16T13:00:00.000Z',
  env: { PATH: '/usr/bin' },
  unsandboxed: false,
};

const plan = (more: Partial<ClaudeAttemptPlan> = {}): ClaudeAttemptPlan => ({
  cwd: '/work/tree',
  env: { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk-test' },
  prompt: assembled.prompt,
  call: {
    model: 'claude-haiku-5-5',
    effort: 'low',
    maxTurns: 3,
    tools: ['Read'],
    session: { kind: 'new', id: sessionId },
  },
  permissions: { allow: ['Read'], deny: [], sandbox: false },
  settingsFile: '/work/attempt/settings.json',
  commits: { clone: '/work/clone.git', branch: 'foedrum/21-1/implement/1' },
  sendBack,
  ...more,
});

const clean: StreamResult = { exitCode: 0, stderr: '' };
const plays = [fixture('success.jsonl'), fixture('resumed.jsonl')];

/** A runner whose claude plays success.jsonl, then resumed.jsonl, and whose checks answer `failing`. */
const setup = (
  options: {
    plan?: ClaudeAttemptPlan;
    /** The check commands that fail, by their first word or two; default none. */
    failing?: (command: string) => boolean;
    changed?: PathsChanged;
    /** The out docs claude leaves, one per start. */
    outDocs?: string[];
    withChecks?: boolean;
    /** What the second start of claude plays; default resumed.jsonl. */
    resumed?: string[];
    /** Runs while a check runs, before it answers. */
    whileChecking?: () => void;
    /** The clock the runner reads; default a fixed time. */
    clock?: { now: Date };
    /** Runs as claude starts, before it writes a line, with how many starts there were. */
    onStart?: (starts: number) => void;
    /** What git says of the commits after the start; default one. */
    commits?: CommitsSeen;
  } = {},
) => {
  const starts: { args: readonly string[]; options: StreamOptions }[] = [];
  const checked: { command: string; options: ExecOptions | undefined }[] = [];
  const failing = options.failing ?? (() => false);
  const docs = options.outDocs ?? [outDoc({ status: 'done', summary: 'Implemented' })];
  const deps: ClaudeRunnerDeps = {
    claude: '/opt/claude/bin/claude',
    plan: async () => options.plan ?? plan(),
    stream: async (_file, args, streamOptions) => {
      starts.push({ args, options: streamOptions });
      options.onStart?.(starts.length);
      const played = [plays[0], options.resumed ?? plays[1]];
      for (const line of played[Math.min(starts.length, played.length) - 1] ?? []) {
        streamOptions.onLine(line);
      }
      // As the real stream process answers a stop.
      if (streamOptions.signal?.aborted === true) {
        return { exitCode: null, stderr: '', killed: 'stopped' };
      }
      return clean;
    },
    files: {
      writeSettings: () => {},
      writeSystemPrompt: () => {},
      readOutDoc: () => ({
        kind: 'text',
        text: docs[Math.min(starts.length, docs.length) - 1] ?? '',
      }),
      clearOutDoc: () => {},
      restoreOutDoc: () => {},
      copyOutDoc: () => {},
    },
    now: () => options.clock?.now ?? new Date('2026-10-16T12:00:00.000Z'),
    wait: async () => {},
    commits: async () => options.commits ?? { kind: 'counted', count: 1 },
    scan: async () => ({ kind: 'scanned', findings: [] }),
    touches: async (_clone, _commit, paths) => ({ kind: 'read', present: new Set(paths) }),
    ...(options.withChecks === false
      ? {}
      : {
          checks: async (command: string, _args: readonly string[], execOptions?: ExecOptions) => {
            checked.push({ command, options: execOptions });
            options.whileChecking?.();
            if (execOptions?.signal?.aborted === true) {
              const stopped: ExecResult = {
                exitCode: null,
                stdout: '',
                stderr: '',
                output: '',
                killed: 'stopped',
              };
              return stopped;
            }
            const fails = failing(command);
            const output = fails ? `src/a.ts:3 ${command} found a problem\n` : '';
            const result: ExecResult = {
              exitCode: fails ? 1 : 0,
              stdout: output,
              stderr: '',
              output,
            };
            return result;
          },
        }),
    changed: async () => options.changed ?? { kind: 'listed', paths: ['src/a.ts'] },
  };
  return { starts, checked, runner: claudeBrewerRunnerWith(deps) };
};

describe('claudeBrewerRunner: the checks before the end (ADR 0381)', () => {
  it('a failing check sends the brewer back once in the same session', async () => {
    const fixed = outDoc({ status: 'done', summary: 'Fixed the lint' });
    const { starts, checked, runner } = setup({
      failing: (command) => command.startsWith('biome lint'),
      outDocs: [outDoc({ status: 'done', summary: 'Implemented' }), fixed],
    });
    const end = await runner.start(attempt).ended;
    assert.equal(starts.length, 2);
    // The same session, resumed, with the failure as its message.
    assert.deepEqual(
      starts[1]?.args,
      claudeArgs({
        ...plan().call,
        session: { kind: 'resume', id: sessionId },
        settingsFile: '/work/attempt/settings.json',
      }),
    );
    const message = String(starts[1]?.options.stdin);
    assert.match(message, /lint exited with 1/);
    assert.match(message, /biome lint "src\/a\.ts"/);
    assert.match(message, /found a problem/);
    // It stopped at the first failure: typecheck, then lint, and not the test line.
    assert.deepEqual(
      checked.map(({ command }) => command),
      ['tsc', 'biome lint "src/a.ts"'],
    );
    assert.deepEqual(end.ending, {
      kind: 'succeeded',
      output: { status: 'done', summary: 'Fixed the lint', assumptions: [] },
    });
  });

  it("starts the resumed run's stall clock when the resume starts, not when the first run did", async () => {
    const clock = { now: new Date('2026-10-16T12:00:00.000Z') };
    const resumedAt = new Date('2026-10-16T12:40:00.000Z');
    let atResume: Date | undefined;
    const made = setup({
      failing: () => true,
      clock,
      // The first session and its checks took 40 minutes, past any brewer's stall minutes.
      whileChecking: () => {
        clock.now = resumedAt;
      },
      onStart: (count) => {
        if (count === 2) atResume = made.runner.progress(attempt.ref)?.lastProgressAt;
      },
    });
    await made.runner.start(attempt).ended;
    assert.equal(made.starts.length, 2);
    assert.equal(atResume?.getTime(), resumedAt.getTime());
  });

  it('lets a resumed run that ends within its own maxTurns succeed, whatever the first run took', async () => {
    // Each start of claude gets --max-turns of its own: here one turn each, two in all.
    const oneTurn: AttemptStart = { ...attempt, limits: { ...limits, maxTurns: 1 } };
    const { starts, runner } = setup({ failing: () => true });
    const end = await runner.start(oneTurn).ended;
    assert.equal(starts.length, 2);
    assert.equal(end.ending.kind, 'succeeded', JSON.stringify(end.ending));
    assert.equal(end.receipt?.turns, 2);
  });

  it('a second failure lets the session end', async () => {
    const { starts, checked, runner } = setup({ failing: () => true });
    const end = await runner.start(attempt).ended;
    // Sent back once: claude started twice, and the checks ran once, before the send-back.
    assert.equal(starts.length, 2);
    assert.deepEqual(
      checked.map(({ command }) => command),
      ['tsc'],
    );
    // The recipe's green is the gate: the attempt ends as the session did.
    assert.equal(end.ending.kind, 'succeeded');
  });

  it('runs the checks in the worktree, in their environment, in a Job Object through the shell, before the deadline', async () => {
    const { starts, checked, runner } = setup();
    const end = await runner.start(attempt).ended;
    assert.equal(starts.length, 1);
    assert.equal(end.ending.kind, 'succeeded');
    assert.deepEqual(
      checked.map(({ command }) => command),
      ['tsc', 'biome lint "src/a.ts"', 'node --test "test/a.test.ts"'],
    );
    for (const { options } of checked) {
      assert.equal(options?.cwd, '/work/tree');
      assert.deepEqual(options?.env, { PATH: '/usr/bin' });
      assert.equal(options?.shell, true);
      assert.equal(options?.jobObject, true);
      assert.ok((options?.timeoutMs ?? 0) > 0);
      assert.ok((options?.timeoutMs ?? Infinity) < 60 * 60 * 1000);
    }
  });

  it('adds the usage of both runs and keeps the resumed session', async () => {
    const once = await setup().runner.start(attempt).ended;
    const twice = await setup({ failing: () => true }).runner.start(attempt).ended;
    // What the resumed run alone reported, read as the runner reads it.
    const resumed = readClaudeStream(
      { sessionId, tools: ['Read'], resumes: true },
      new Date('2026-10-16T12:00:00.000Z'),
    );
    for (const line of plays[1] ?? []) resumed.read(line, new Date('2026-10-16T12:00:00.000Z'));
    const [first, second] = [once.usage, resumed.facts().usage];
    assert.ok(first !== undefined && second !== undefined);
    assert.deepEqual(twice.usage, {
      inputTokens: first.inputTokens + second.inputTokens,
      outputTokens: first.outputTokens + second.outputTokens,
      cacheReadTokens: first.cacheReadTokens + second.cacheReadTokens,
      cacheWriteTokens: first.cacheWriteTokens + second.cacheWriteTokens,
    });
    assert.equal(twice.session?.sessionId, sessionId);
    assert.equal(twice.receipt?.resumed, true);
    assert.equal(twice.receipt?.turns, (once.receipt?.turns ?? 0) + resumed.receipt().turns);
  });
  it('runs no checks for a plan without them, nor without a process runner for them', async () => {
    const { sendBack: _, ...withoutChecks } = plan();
    const without = setup({ plan: withoutChecks, failing: () => true });
    await without.runner.start(attempt).ended;
    assert.equal(without.starts.length, 1);
    assert.deepEqual(without.checked, []);
    const unwired = setup({ withChecks: false });
    assert.equal((await unwired.runner.start(attempt).ended).ending.kind, 'succeeded');
    assert.equal(unwired.starts.length, 1);
  });

  it('runs no checks when the session did not end done', async () => {
    const question = { q: 'Which flag?', options: ['a', 'b'], recommended: 'a', whyBlocking: 'x' };
    const asked = outDoc({ status: 'needs_input', summary: 'Which flag?', questions: [question] });
    const { starts, checked, runner } = setup({ failing: () => true, outDocs: [asked] });
    await runner.start(attempt).ended;
    assert.equal(starts.length, 1);
    assert.deepEqual(checked, []);
  });

  it('cancels an attempt stopped while its checks run, and starts claude no more', async () => {
    let stop = (): void => {};
    const { starts, runner } = setup({ failing: () => true, whileChecking: () => stop() });
    const running = runner.start(attempt);
    stop = running.stop;
    const end = await running.ended;
    assert.equal(end.ending.kind, 'cancelled');
    assert.equal(starts.length, 1);
  });

  it('keeps the first end when the session it sends back to does not resume', async () => {
    const { starts, runner } = setup({
      failing: () => true,
      resumed: fixture('resume-not-found.jsonl'),
    });
    const end = await runner.start(attempt).ended;
    assert.equal(starts.length, 2);
    assert.deepEqual(end.ending, {
      kind: 'succeeded',
      output: { status: 'done', summary: 'Implemented', assumptions: [] },
    });
    assert.equal(end.receipt?.resumed, undefined);
  });

  it('runs lint whole when git could not list the changed files', async () => {
    const { checked, runner } = setup({ changed: { kind: 'unlisted', reason: 'git failed' } });
    await runner.start(attempt).ended;
    assert.deepEqual(
      checked.map(({ command }) => command),
      ['tsc', 'biome lint', 'node --test "test/a.test.ts"'],
    );
  });
  it('cancels an attempt stopped while its resumed session runs', async () => {
    let stop = (): void => {};
    const made = setup({
      failing: () => true,
      onStart: (count) => {
        if (count === 2) stop();
      },
    });
    const running = made.runner.start(attempt);
    stop = running.stop;
    const end = await running.ended;
    assert.equal(made.starts.length, 2);
    assert.equal(end.ending.kind, 'cancelled');
  });

  it('reports progress while its checks run, whatever the stream said last', async () => {
    const clock = { now: new Date('2026-10-16T12:00:00.000Z') };
    const seen: ReturnType<ReturnType<typeof setup>['runner']['progress']>[] = [];
    const made = setup({
      clock,
      whileChecking: () => {
        clock.now = new Date('2026-10-16T12:45:00.000Z');
        seen.push(made.runner.progress(attempt.ref));
      },
    });
    await made.runner.start(attempt).ended;
    assert.ok(seen.length > 0);
    for (const progress of seen) {
      assert.equal(progress?.lastProgressAt.getTime(), clock.now.getTime());
      assert.equal(progress?.turnsWithoutProgress, 0);
    }
  });

  it('runs no checks when the session made no commit, or the attempt has no start to count from', async () => {
    const none = setup({ failing: () => true, commits: { kind: 'counted', count: 0 } });
    await none.runner.start(attempt).ended;
    assert.deepEqual(none.checked, []);
    const { commitsSince: _, ...unstarted } = limits;
    const fresh = setup({ failing: () => true });
    await fresh.runner.start({ ...attempt, limits: unstarted }).ended;
    assert.deepEqual(fresh.checked, []);
    assert.equal(fresh.starts.length, 1);
  });

  it("resumes with the attempt's system prompt file too", async () => {
    const systemPrompt = { file: '/work/attempt/system.md', text: 'The rules.' };
    const { starts, runner } = setup({ plan: plan({ systemPrompt }), failing: () => true });
    await runner.start(attempt).ended;
    assert.deepEqual(
      starts[1]?.args,
      claudeArgs({
        ...plan().call,
        session: { kind: 'resume', id: sessionId },
        settingsFile: '/work/attempt/settings.json',
        appendSystemPromptFile: '/work/attempt/system.md',
      }),
    );
  });
});
