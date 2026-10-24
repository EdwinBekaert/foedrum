// The real brewer runner's shell (#11, ADR 0047) with a fake stream process that plays the
// captured streams of #17: what it starts, what it writes, and how each attempt ends.

import assert from 'node:assert/strict';
import {
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { attemptSettings } from '../../src/brewers/attempt-settings.ts';
import { claudeArgs } from '../../src/brewers/claude-command.ts';
import {
  type ClaudeAttemptPlan,
  type ClaudeRunnerDeps,
  claudeBrewerRunnerWith,
  clearOutDocFile,
  readOutDocFile,
  waitFor,
} from '../../src/brewers/claude-runner.ts';
import { assembleBrewerPrompt, type BrewerPrompt } from '../../src/brewers/prompt.ts';
import type { AttemptLimits, AttemptStart, CommitsSeen } from '../../src/engine/brewer-runner.ts';
import type { StreamOptions, StreamResult } from '../../src/platform/processes.ts';
import type { AttemptSettings } from '../../src/schemas/attempt-settings.ts';
import { OutDocFrontmatter } from '../../src/schemas/out-doc.ts';
import {
  documentedUsageLimits,
  limitResults,
  rejectedRateLimit,
} from '../fixtures/claude-usage-limits.ts';
import { outDoc } from '../helpers/fake-brewer-runner.ts';
import { descheduled } from '../helpers/load.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';

const fixtures = join(import.meta.dirname, '..', 'fixtures', 'claude-stream');
const fixture = (file: string): string[] =>
  readFileSync(join(fixtures, file), 'utf8')
    .split('\n')
    .filter((line) => line !== '');

const session = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const assembled = assembleBrewerPrompt('Plan the change.', []);
if (assembled.kind !== 'assembled') throw new Error('the test prompt was refused');
const prompt: BrewerPrompt = assembled.prompt;

const limits: AttemptLimits = {
  outDoc: { file: 'plan.md', schema: OutDocFrontmatter },
  maxTurns: 3,
  maxDenials: 5,
};
const attempt: AttemptStart = { ref: { batchId: '21-1', stepId: 'plan', attempt: 1 }, limits };

const plan = (id = 1, tools = ['Read']): ClaudeAttemptPlan => ({
  cwd: '/work/tree',
  env: { PATH: '/usr/bin' },
  prompt,
  call: {
    model: 'claude-haiku-5-5',
    effort: 'low',
    maxTurns: 3,
    tools,
    session: { kind: 'new', id: session(id) },
  },
  // A shell is allowed one command, as a brewer's tools.allow scopes it (ADR 0062).
  permissions: {
    allow: tools.map((tool) => (tool === 'Bash' ? 'Bash(npm test)' : tool)),
    deny: [],
    sandbox: false,
  },
  settingsFile: '/work/attempt/settings.json',
});

const done = outDoc({ status: 'done', summary: 'Planned' });

interface Call {
  file: string;
  args: readonly string[];
  options: StreamOptions;
}

/** What a fake claude does: the lines it writes, then how it ends, or it runs until stopped. */
type Play =
  | { lines: string[]; result: StreamResult }
  | { lines: string[]; hang: true }
  | { throws: Error };

const at = (seconds: number): Date => new Date(Date.UTC(2026, 9, 16, 12, 0, seconds));

const setup = (
  plays: Play | readonly Play[],
  more: {
    plan?: () => Promise<ClaudeAttemptPlan>;
    outDoc?: string | undefined | { unread: string };
    /** A wait that never ends, so the attempt can be stopped while it waits. */
    waitForever?: boolean;
    /** What git says of the commits after the start (ADR 0074); default one. */
    commits?: CommitsSeen;
    /** Runs while the commits are counted, before the count answers. */
    whileCounting?: () => void;
    /** Why removing the out doc a run before left fails, if it does. */
    clearFails?: string;
  } = {},
) => {
  const counts: {
    clone: string;
    branch: string;
    since: string;
    signal: AbortSignal | undefined;
  }[] = [];
  // One play per start of claude, the last one again for every start after it.
  const queue = Array.isArray(plays) ? [...plays] : [plays];
  const calls: Call[] = [];
  const waits: number[] = [];
  const written: { file: string; settings: AttemptSettings }[] = [];
  const read: { file: string; maxBytes: number; root: string }[] = [];
  /** Each out doc cleared, with how many starts of claude came before it. */
  const cleared: { file: string; root: string; starts: number }[] = [];
  let clock = 0;
  const deps: ClaudeRunnerDeps = {
    claude: '/opt/claude/bin/claude',
    plan: more.plan ?? (async () => plan()),
    stream: async (file, args, options) => {
      calls.push({ file, args, options });
      const play = (queue.length > 1 ? queue.shift() : queue[0]) as Play;
      if ('throws' in play) throw play.throws;
      for (const line of play.lines) {
        if (options.signal?.aborted) break;
        options.onLine(line);
      }
      if (options.signal?.aborted) return { exitCode: null, stderr: '', killed: 'stopped' };
      if ('result' in play) return play.result;
      return new Promise<StreamResult>((answer) =>
        options.signal?.addEventListener('abort', () =>
          answer({ exitCode: null, stderr: '', killed: 'stopped' }),
        ),
      );
    },
    files: {
      writeSettings: (file, settings) => {
        written.push({ file, settings });
      },
      readOutDoc: (file, maxBytes, root = '') => {
        read.push({ file, maxBytes, root });
        const text = 'outDoc' in more ? more.outDoc : done;
        if (text === undefined) return { kind: 'missing' };
        if (typeof text === 'object') return { kind: 'unread', reason: text.unread };
        return { kind: 'text', text };
      },
      clearOutDoc: (file, root) => {
        cleared.push({ file, root, starts: calls.length });
        if (more.clearFails !== undefined) throw new Error(more.clearFails);
      },
    },
    now: () => {
      clock += 1;
      return at(clock);
    },
    wait: (ms, signal) => {
      waits.push(ms);
      if (more.waitForever !== true) return Promise.resolve();
      return new Promise<void>((done) => signal.addEventListener('abort', () => done()));
    },
    commits: async (clone, branch, since, signal) => {
      counts.push({ clone, branch, since, signal });
      more.whileCounting?.();
      return more.commits ?? { kind: 'counted', count: 1 };
    },
  };
  return { calls, written, read, cleared, waits, counts, runner: claudeBrewerRunnerWith(deps) };
};

const exited = (code: number, stderr = ''): StreamResult => ({ exitCode: code, stderr });

describe('claudeBrewerRunner', () => {
  it("starts claude with the attempt's command line, its prompt on stdin, in a Job Object", async () => {
    const { calls, written, runner } = setup({
      lines: fixture('success.jsonl'),
      result: exited(0),
    });
    await runner.start(attempt).ended;
    const settingsFile = '/work/attempt/settings.json';
    assert.deepEqual(written, [
      { file: settingsFile, settings: attemptSettings(plan().permissions) },
    ]);
    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.equal(call?.file, '/opt/claude/bin/claude');
    assert.deepEqual(call?.args, claudeArgs({ ...plan().call, settingsFile }));
    assert.equal(call?.options.stdin, prompt);
    assert.equal(call?.options.cwd, '/work/tree');
    assert.deepEqual(call?.options.env, { PATH: '/usr/bin' });
    assert.equal(call?.options.jobObject, true);
    assert.ok((call?.options.maxLineBytes ?? 0) >= 1024 * 1024);
  });

  it('fails retryably when claude finds no session to resume, so the next attempt starts fresh (ADR 0117)', async () => {
    const resuming = plan();
    const resume: ClaudeAttemptPlan = {
      ...resuming,
      call: { ...resuming.call, session: { kind: 'resume', id: session(1) } },
    };
    const { runner } = setup(
      { lines: fixture('resume-not-found.jsonl'), result: exited(1) },
      { plan: async () => resume, outDoc: undefined },
    );
    const { ending } = await runner.start(attempt).ended;
    assert.equal(ending.kind, 'failed');
    assert.ok(ending.kind === 'failed' && ending.retryable);
    assert.match(
      ending.kind === 'failed' ? ending.reason : '',
      /^claude could not resume the session: No conversation found with session ID/,
    );
  });

  // Review of #380: a resumed run that writes no out doc would otherwise be read by the one the
  // run before left, such as its needs_input, and ask its questions again.
  it('removes the out doc a run before left before claude resumes its session, and only then (ADR 0118)', async () => {
    const resuming = plan();
    const resume: ClaudeAttemptPlan = {
      ...resuming,
      call: { ...resuming.call, session: { kind: 'resume', id: session(1) } },
    };
    const resumed = setup(
      { lines: fixture('success.jsonl'), result: exited(0) },
      { plan: async () => resume },
    );
    await resumed.runner.start(attempt).ended;
    assert.deepEqual(resumed.cleared, [
      { file: resolve('/work/tree', 'plan.md'), root: '/work/tree', starts: 0 },
    ]);

    const fresh = setup({ lines: fixture('success.jsonl'), result: exited(0) });
    await fresh.runner.start(attempt).ended;
    assert.deepEqual(fresh.cleared, []);
  });

  it('does not start claude when the out doc a run before left cannot be removed (ADR 0118)', async () => {
    const resuming = plan();
    const resume: ClaudeAttemptPlan = {
      ...resuming,
      call: { ...resuming.call, session: { kind: 'resume', id: session(1) } },
    };
    const { calls, runner } = setup(
      { lines: fixture('success.jsonl'), result: exited(0) },
      { plan: async () => resume, clearFails: 'EBUSY: resource busy or locked' },
    );
    const { ending } = await runner.start(attempt).ended;
    assert.deepEqual(calls, []);
    assert.equal(ending.kind, 'failed');
    assert.match(ending.kind === 'failed' ? ending.reason : '', /EBUSY/);
  });

  // What success.jsonl took (ADR 0172).
  const cleanReceipt = {
    complete: true,
    durationMs: 1568,
    apiDurationMs: 1434,
    turns: 1,
    costUsd: 0.0005093000000000001,
    models: [
      {
        model: 'claude-haiku-5-5',
        inputTokens: 2,
        outputTokens: 4,
        cacheReadTokens: 1670,
        cacheWriteTokens: 2452,
        costUsd: 0.0005093000000000001,
      },
    ],
    edits: 0,
    toolErrors: 0,
    denied: [],
  };

  it('succeeds with the out doc, the usage, the receipt and the session of a clean run', async () => {
    const { read, runner } = setup({ lines: fixture('success.jsonl'), result: exited(0) });
    const end = await runner.start(attempt).ended;
    assert.deepEqual(end, {
      ending: {
        kind: 'succeeded',
        output: { status: 'done', summary: 'Planned', assumptions: [] },
      },
      usage: { inputTokens: 2, outputTokens: 4, cacheReadTokens: 1670, cacheWriteTokens: 2452 },
      receipt: cleanReceipt,
      session: { sessionId: session(1), model: 'claude-haiku-5-5', claudeVersion: '2.1.301' },
      // Its text as read, for the state branch (ADR 0103).
      outDoc: done,
    });
    assert.deepEqual(
      read.map((r) => r.file),
      [resolve('/work/tree', 'plan.md')],
    );
  });

  describe('a brewer that produces commits (ADR 0074)', () => {
    const start = 'c'.repeat(40);
    const committing: AttemptStart = { ...attempt, limits: { ...limits, commitsSince: start } };
    // Where the attempt's commits are: its branch in the clone, never what its worktree says.
    const inClone = { clone: '/work/clone.git', branch: 'foedrum/21-1/plan/1' };
    const counting = async (): Promise<ClaudeAttemptPlan> => ({ ...plan(), commits: inClone });
    const clean = { lines: fixture('success.jsonl'), result: exited(0) };

    it("counts the commits after the start on the attempt's branch in the clone once claude ended, and succeeds on one", async () => {
      const { counts, runner } = setup(clean, { plan: counting });
      const end = await runner.start(committing).ended;
      assert.equal(end.ending.kind, 'succeeded');
      assert.deepEqual(
        counts.map(({ clone, branch, since }) => [clone, branch, since]),
        [['/work/clone.git', 'foedrum/21-1/plan/1', start]],
      );
      assert.ok(counts[0]?.signal instanceof AbortSignal);
    });

    it('blocks on a divergence when the out doc says done but nothing was committed (#196)', async () => {
      const { runner } = setup(
        { lines: fixture('success.jsonl'), result: exited(0) },
        { commits: { kind: 'counted', count: 0 }, plan: counting },
      );
      const end = await runner.start(committing).ended;
      assert.deepEqual(end.ending, {
        kind: 'blocked',
        blockerKind: 'divergence',
        summary: 'the out doc says done, but the brewer made no commit since ccccccc: Planned',
      });
    });

    it('blocks on the environment when git could not count them', async () => {
      const { runner } = setup(
        { lines: fixture('success.jsonl'), result: exited(0) },
        { commits: { kind: 'uncounted', reason: 'git exited with 128' }, plan: counting },
      );
      const end = await runner.start(committing).ended;
      assert.deepEqual(end.ending, {
        kind: 'blocked',
        blockerKind: 'environment',
        summary: 'the commits since ccccccc were not counted: git exited with 128',
      });
    });

    it('blocks on the environment, counting nothing, when the plan names no clone to count in', async () => {
      const { counts, runner } = setup(clean);
      const end = await runner.start(committing).ended;
      assert.deepEqual(end.ending, {
        kind: 'blocked',
        blockerKind: 'environment',
        summary:
          'the commits since ccccccc were not counted: the plan names no clone to count them in',
      });
      assert.deepEqual(counts, []);
    });

    it('cancels an attempt stopped while its commits are counted, not blaming git (review of #208)', async () => {
      let stop = (): void => {};
      const { runner } = setup(clean, {
        plan: counting,
        // A stop kills git: the count then says git did not finish.
        whileCounting: () => stop(),
        commits: { kind: 'uncounted', reason: 'git merge-base failed: git did not finish in time' },
      });
      const run = runner.start(committing);
      stop = run.stop;
      assert.deepEqual((await run.ended).ending, { kind: 'cancelled' });
    });

    it('keeps the usage and the session the stream reported when stopped while counting (review of #208)', async () => {
      let stop = (): void => {};
      const { runner } = setup(clean, { plan: counting, whileCounting: () => stop() });
      const run = runner.start(committing);
      stop = run.stop;
      assert.deepEqual(await run.ended, {
        ending: { kind: 'cancelled' },
        usage: { inputTokens: 2, outputTokens: 4, cacheReadTokens: 1670, cacheWriteTokens: 2452 },
        receipt: cleanReceipt,
        session: { sessionId: session(1), model: 'claude-haiku-5-5', claudeVersion: '2.1.301' },
      });
    });

    it('blocks on the environment with the reason when the count itself throws (review of #208)', async () => {
      const { runner } = setup(clean, {
        plan: counting,
        whileCounting: () => {
          throw new Error('boom');
        },
      });
      assert.deepEqual((await runner.start(committing).ended).ending, {
        kind: 'blocked',
        blockerKind: 'environment',
        summary: 'the commits since ccccccc were not counted: boom',
      });
    });

    it("counts with the attempt's own stop signal, which a stop aborts (review of #208)", async () => {
      let stop = (): void => {};
      const { counts, runner } = setup(clean, { plan: counting, whileCounting: () => stop() });
      const run = runner.start(committing);
      stop = run.stop;
      await run.ended;
      assert.equal(counts[0]?.signal?.aborted, true);
    });

    it('counts nothing for an attempt whose limits name no start', async () => {
      const { counts, runner } = setup({ lines: fixture('success.jsonl'), result: exited(0) });
      await runner.start(attempt).ended;
      assert.deepEqual(counts, []);
    });
  });

  it('stops at an init that is not what was asked, and blocks on the environment', async () => {
    const { runner } = setup(
      { lines: fixture('tool-removed-by-deny.jsonl'), result: exited(0) },
      { plan: async () => plan(14, ['Read', 'Bash']) },
    );
    const end = await runner.start(attempt).ended;
    assert.deepEqual(end.ending, {
      kind: 'blocked',
      blockerKind: 'environment',
      summary:
        'claude did not set up the session the runner asked for: tools asked for but missing: "Bash"',
    });
  });

  it('stops at the denial that reaches maxDenials', async () => {
    const { runner } = setup(
      { lines: fixture('permission-denials.jsonl'), result: exited(0) },
      { plan: async () => plan(32, ['Bash', 'Read', 'Write']) },
    );
    const end = await runner.start({ ...attempt, limits: { ...limits, maxDenials: 2 } }).ended;
    assert.deepEqual(end.ending, {
      kind: 'blocked',
      blockerKind: 'environment',
      summary: '2 permission denials, maxDenials is 2; denied: Write, Bash',
    });
    // Stopped before its result: what was seen, the refused rule named (ADR 0172).
    assert.equal(end.receipt?.complete, false);
    assert.deepEqual(end.receipt?.denied, [
      { tool: 'Write', count: 1, refused: [] },
      { tool: 'Bash', count: 1, refused: ['git push'] },
    ]);
  });

  // ADR 0047: the process is stopped at that line, so it spends no more turns.
  it('stops the process at a mismatched init or at maxDenials, and not at a clean run', async () => {
    for (const [file, id, tools, maxDenials, stopped] of [
      ['tool-removed-by-deny.jsonl', 14, ['Read', 'Bash'], 5, true],
      ['permission-denials.jsonl', 32, ['Bash', 'Read', 'Write'], 2, true],
      ['permission-denials.jsonl', 32, ['Bash', 'Read', 'Write'], 3, false],
      ['success.jsonl', 1, ['Read'], 5, false],
    ] as const) {
      const { calls, runner } = setup(
        { lines: fixture(file), result: exited(0) },
        { plan: async () => plan(id, [...tools]) },
      );
      await runner.start({ ...attempt, limits: { ...limits, maxDenials } }).ended;
      assert.equal(calls[0]?.options.signal?.aborted, stopped, `${file}, maxDenials ${maxDenials}`);
    }
  });

  it('fails, retryably, on a stream line that is not stream-json, even with a valid out doc', async () => {
    const lines = fixture('success.jsonl');
    const { runner } = setup({
      lines: [...lines.slice(0, 2), 'Abort trap', ...lines.slice(2)],
      result: exited(0),
    });
    const end = await runner.start(attempt).ended;
    assert.deepEqual(end.ending, {
      kind: 'failed',
      retryable: true,
      reason: 'the event stream is not stream-json: "Abort trap"',
    });
  });

  // The consultant's item 4 (#11): never spend another attempt on the same wrong model.
  it('blocks on the environment when claude fails before the model replied', async () => {
    const { runner } = setup(
      { lines: fixture('model-not-found.jsonl'), result: exited(1) },
      { plan: async () => plan(68), outDoc: undefined },
    );
    const end = await runner.start(attempt).ended;
    assert.equal(end.ending.kind, 'blocked');
    assert.match(
      end.ending.kind === 'blocked' ? end.ending.summary : '',
      /claude failed before the model replied: model_not_found/,
    );
  });

  // #134: a refusal claude says it will repeat is the environment at once, without a retry.
  it('blocks on a lasting refusal from the first start, without starting claude again', async () => {
    for (const said of [
      "error: unknown option '--bogus'",
      "error: option '--model <model>' argument missing",
      'Error: When using --print, --output-format=stream-json requires --verbose',
      'Error: Invalid session ID. Must be a valid UUID.',
      'Invalid API key · Please run /login',
      'Not logged in · Please run /login',
    ]) {
      const { calls, waits, runner } = setup(
        { lines: [], result: exited(1, `${said}\n`) },
        { outDoc: undefined },
      );
      const end = await runner.start(attempt).ended;
      assert.equal(end.ending.kind, 'blocked', said);
      assert.equal(calls.length, 1, said);
      assert.deepEqual(waits, [], said);
    }
  });

  // #134: a network blip at startup must not get the batch Stuck.
  it('starts claude once more after a failure before its first line that names no lasting cause', async () => {
    const { calls, waits, runner } = setup([
      { lines: [], result: exited(1, 'Error: connect ECONNRESET 160.79.104.10:443\n') },
      { lines: fixture('success.jsonl'), result: exited(0) },
    ]);
    const end = await runner.start(attempt).ended;
    assert.equal(end.ending.kind, 'succeeded');
    assert.equal(calls.length, 2);
    assert.deepEqual(waits, [5000]);
    assert.deepEqual(calls[1]?.args, calls[0]?.args);
  });

  it('blocks on the environment when the second start fails before its first line too', async () => {
    const { calls, runner } = setup(
      { lines: [], result: exited(1, 'Error: connect ECONNRESET 160.79.104.10:443\n') },
      { outDoc: undefined },
    );
    const end = await runner.start(attempt).ended;
    assert.equal(calls.length, 2);
    assert.deepEqual(end.ending, {
      kind: 'blocked',
      blockerKind: 'environment',
      summary:
        'claude did not set up the session the runner asked for: claude refused to start: Error: connect ECONNRESET 160.79.104.10:443',
    });
  });

  // Review of #136: claude 2.1.301 refuses a session id that a start which wrote its stream has
  // taken; it would refuse it again, so it is a lasting refusal, not one to retry.
  it('blocks on a session id that is already in use, without starting claude again', async () => {
    const { calls, waits, runner } = setup(
      {
        lines: [],
        result: exited(1, `Error: Session ID ${session(1)} is already in use.\n`),
      },
      { outDoc: undefined },
    );
    const end = await runner.start(attempt).ended;
    assert.equal(end.ending.kind, 'blocked');
    assert.equal(calls.length, 1);
    assert.deepEqual(waits, []);
  });

  it('blocks on a refusal that only asks to log in again', async () => {
    const { calls, waits, runner } = setup(
      { lines: [], result: exited(1, 'Session expired · Please run /login') },
      { outDoc: undefined },
    );
    const end = await runner.start(attempt).ended;
    assert.equal(end.ending.kind, 'blocked');
    assert.equal(calls.length, 1);
    assert.deepEqual(waits, []);
  });

  it('blocks on each lasting refusal by itself, also without the login hint', async () => {
    for (const said of [
      'error: missing required argument "prompt"',
      'Not logged in',
      'Invalid API key',
    ]) {
      const { calls, waits, runner } = setup(
        { lines: [], result: exited(1, said) },
        { outDoc: undefined },
      );
      const end = await runner.start(attempt).ended;
      assert.equal(end.ending.kind, 'blocked', said);
      assert.equal(calls.length, 1, said);
      assert.deepEqual(waits, [], said);
    }
  });

  // ADR 0046, ADR 0048: only an exit before any stream line gets one more start.
  it('never starts claude again after it wrote a line', async () => {
    for (const [file, id, tools, result] of [
      ['tool-removed-by-deny.jsonl', 14, ['Read', 'Bash'], exited(0)],
      ['model-not-found.jsonl', 68, ['Read'], exited(1)],
      ['success.jsonl', 1, ['Read'], exited(1, 'Error: connect ECONNRESET')],
    ] as const) {
      const lines = file === 'success.jsonl' ? fixture(file).slice(0, 2) : fixture(file);
      const { calls, waits, runner } = setup(
        { lines, result },
        { plan: async () => plan(id, [...tools]), outDoc: undefined },
      );
      await runner.start(attempt).ended;
      assert.equal(calls.length, 1, file);
      assert.deepEqual(waits, [], file);
    }
  });

  it('cancels an attempt stopped while it waits to start claude again', async () => {
    const { calls, runner } = setup(
      { lines: [], result: exited(1, 'Error: connect ECONNRESET\n') },
      { outDoc: undefined, waitForever: true },
    );
    const running = runner.start(attempt);
    await new Promise((settled) => setImmediate(settled));
    running.stop();
    assert.deepEqual((await running.ended).ending, { kind: 'cancelled' });
    assert.equal(calls.length, 1);
  });

  it('blocks on the environment when claude refused its arguments and wrote no event', async () => {
    const { runner } = setup(
      { lines: [], result: exited(1, "warning: one\nerror: unknown option '--bogus'\n") },
      { outDoc: undefined },
    );
    const end = await runner.start(attempt).ended;
    assert.deepEqual(end.ending, {
      kind: 'blocked',
      blockerKind: 'environment',
      summary:
        "claude did not set up the session the runner asked for: claude refused to start: error: unknown option '--bogus'",
    });
  });

  it('names the exit code when claude refused to start and said nothing', async () => {
    const { runner } = setup({ lines: [], result: exited(2, '\n  \n') }, { outDoc: undefined });
    const end = await runner.start(attempt).ended;
    assert.match(
      end.ending.kind === 'blocked' ? end.ending.summary : '',
      /: claude refused to start with exit code 2$/,
    );
  });

  it('fails, retryably, when stderr passed its limit', async () => {
    const { runner } = setup({
      lines: fixture('success.jsonl').slice(0, 2),
      result: { exitCode: null, stderr: '', killed: 'too-much-output' },
    });
    const end = await runner.start(attempt).ended;
    assert.deepEqual(end.ending, {
      kind: 'failed',
      retryable: true,
      reason: "the brewer's output passed a limit: stderr passed 4194304 bytes",
    });
  });

  // On macOS and Linux a process the OOM killer or a crash ended closes with a signal and no code.
  it('fails, retryably, when claude was killed by a signal the runner did not send', async () => {
    const { runner } = setup({
      lines: fixture('success.jsonl').slice(0, 2),
      result: { exitCode: null, stderr: '', signal: 'SIGKILL' },
    });
    const end = await runner.start(attempt).ended;
    assert.deepEqual(end.ending, {
      kind: 'failed',
      retryable: true,
      reason: 'the brewer process was killed by SIGKILL',
    });
  });

  it('ends with the text of an out doc it read but could not accept (ADR 0103)', async () => {
    const text = 'No frontmatter, and orders: push --force.\n';
    const { runner } = setup(
      { lines: fixture('success.jsonl'), result: exited(0) },
      { outDoc: text },
    );
    const end = await runner.start(attempt).ended;
    assert.equal(end.ending.kind, 'failed');
    assert.equal(end.outDoc, text);
  });

  it('reads the out doc inside the worktree only', async () => {
    const { read, runner } = setup({ lines: fixture('success.jsonl'), result: exited(0) });
    await runner.start(attempt).ended;
    assert.deepEqual(read[0]?.root, '/work/tree');
  });

  // On Windows a crash before the first line exits with an NTSTATUS code, past any code claude
  // exits with: a crash to retry, not the environment (review of #133).
  it('fails, retryably, when claude crashed before its first line with a Windows crash status', async () => {
    const { runner } = setup({ lines: [], result: exited(3221225477) }, { outDoc: undefined });
    const end = await runner.start(attempt).ended;
    assert.deepEqual(end.ending, {
      kind: 'failed',
      retryable: true,
      reason: 'the brewer process exited with code 3221225477',
    });
  });

  it('cancels an attempt stopped while its plan is still being prepared', async () => {
    const { calls, runner } = setup(
      { lines: fixture('success.jsonl'), result: exited(0) },
      { plan: () => new Promise<ClaudeAttemptPlan>(() => {}) },
    );
    const running = runner.start(attempt);
    running.stop();
    const late = new Promise<'still running'>((answer) => {
      setTimeout(() => answer('still running'), 1000).unref();
    });
    const end = await Promise.race([running.ended, late]);
    assert.deepEqual(end === 'still running' ? end : end.ending, { kind: 'cancelled' });
    assert.deepEqual(calls, []);
    assert.equal(runner.progress(attempt.ref), undefined);
  });

  // ADR 0047: an event may hold a whole file the brewer read.
  it('allows a stream line of 8 MiB', async () => {
    const { calls, runner } = setup({ lines: fixture('success.jsonl'), result: exited(0) });
    await runner.start(attempt).ended;
    assert.equal(calls[0]?.options.maxLineBytes, 8 * 1024 * 1024);
  });

  it('fails, not retryably, when claude could not start', async () => {
    const { runner } = setup(
      { lines: [], result: { exitCode: null, stderr: 'claude: not found on PATH (ENOENT)' } },
      { outDoc: undefined },
    );
    const end = await runner.start(attempt).ended;
    assert.deepEqual(end.ending, {
      kind: 'failed',
      retryable: false,
      reason: 'the brewer could not start: claude: not found on PATH (ENOENT)',
    });
  });

  // Review of #459: claude never ran, so there is nothing it took (ADR 0172).
  it('ends with no receipt when claude could not start', async () => {
    const { runner } = setup(
      { lines: [], result: { exitCode: null, stderr: 'claude: not found on PATH (ENOENT)' } },
      { outDoc: undefined },
    );
    const end = await runner.start(attempt).ended;
    assert.equal(end.ending.kind, 'failed');
    assert.equal(end.receipt, undefined);
  });

  it('fails, not retryably, and starts nothing, when the attempt cannot be prepared', async () => {
    const { calls, runner } = setup(
      { lines: [], result: exited(0) },
      {
        plan: async () => {
          throw new Error('the worktree is gone');
        },
      },
    );
    const end = await runner.start(attempt).ended;
    assert.deepEqual(end.ending, {
      kind: 'failed',
      retryable: false,
      reason: 'the brewer could not start: the worktree is gone',
    });
    assert.deepEqual(calls, []);
  });

  // A repository's toolchain rules reach the attempt unchecked by the brewer schema, and Claude
  // Code never consults a Write path rule (ADR 0093).
  it('fails, not retryably, and starts nothing, when a rule names a Write path', async () => {
    const writing = plan();
    const { calls, runner } = setup(
      { lines: [], result: exited(0) },
      {
        plan: async () => ({
          ...writing,
          permissions: { ...writing.permissions, allow: ['Read', 'Write(brew.md)'] },
        }),
      },
    );
    const end = await runner.start(attempt).ended;
    assert.ok(end.ending.kind === 'failed' && !end.ending.retryable, JSON.stringify(end.ending));
    assert.match(
      end.ending.reason ?? '',
      /^the brewer could not start: .*write "Edit\(brew\.md\)"/s,
    );
    assert.deepEqual(calls, []);
  });

  it('fails, not retryably, when the stream process itself throws', async () => {
    const { runner } = setup({ throws: new Error('spawn EMFILE') });
    const end = await runner.start(attempt).ended;
    assert.deepEqual(end.ending, {
      kind: 'failed',
      retryable: false,
      reason: 'the brewer could not start: spawn EMFILE',
    });
  });

  it('fails, retryably, when a stream line passed its limit', async () => {
    const { runner } = setup({
      lines: fixture('success.jsonl').slice(0, 2),
      result: { exitCode: null, stderr: '', killed: 'line-too-long' },
    });
    const end = await runner.start(attempt).ended;
    assert.equal(end.ending.kind, 'failed');
    assert.ok(end.ending.kind === 'failed' && end.ending.retryable);
    assert.match(
      end.ending.kind === 'failed' ? end.ending.reason : '',
      /^the brewer's output passed a limit: a stream line passed \d+ bytes$/,
    );
  });

  it('fails, retryably, when claude reported an error after the model replied', async () => {
    const { runner } = setup(
      { lines: fixture('max-turns.jsonl'), result: exited(1) },
      { plan: async () => plan(59), outDoc: undefined },
    );
    const end = await runner.start({ ...attempt, limits: { ...limits, maxTurns: 5 } }).ended;
    assert.deepEqual(end.ending, {
      kind: 'failed',
      retryable: true,
      reason: 'claude reported an error: max_turns: Reached maximum number of turns (1)',
    });
  });

  // #238, ADR 0091: claude refuses every request until the window resets, so retrying now would
  // spend the step's attempts on the same refusal. Stuck at once, on the environment.
  it('blocks on the environment when a usage window ran out, naming the limit and its reset', async () => {
    const [initLine] = fixture('success.jsonl');
    for (const { text, limit, resets } of documentedUsageLimits) {
      for (const end of limitResults(text)) {
        const { calls, runner } = setup(
          { lines: [initLine ?? '', rejectedRateLimit, end], result: exited(1) },
          { outDoc: undefined },
        );
        const ended = await runner.start(attempt).ended;
        assert.deepEqual(ended.ending, {
          kind: 'blocked',
          blockerKind: 'environment',
          summary: `claude hit its ${limit} limit, which resets ${resets}: retry the step after that`,
        });
        assert.equal(calls.length, 1);
      }
    }
  });

  // #257, ADR 0129: no request goes through until a human raises the limit, so retrying now
  // would spend the step's attempts on the same refusal.
  it('blocks on the environment when a spend limit refused it', async () => {
    const [initLine] = fixture('success.jsonl');
    for (const end of limitResults("You've hit your org's monthly spend limit")) {
      const { calls, runner } = setup(
        { lines: [initLine ?? '', end], result: exited(1) },
        { outDoc: undefined },
      );
      const ended = await runner.start(attempt).ended;
      assert.deepEqual(ended.ending, {
        kind: 'blocked',
        blockerKind: 'environment',
        summary:
          "claude hit its org's monthly spend limit: no request goes through until the limit is raised, then retry the step",
      });
      assert.equal(calls.length, 1);
    }
  });

  it('fails, retryably, with the reason when the out doc was not read', async () => {
    const { read, runner } = setup(
      { lines: fixture('success.jsonl'), result: exited(0) },
      { outDoc: { unread: 'it is larger than 1048576 bytes' } },
    );
    const end = await runner.start(attempt).ended;
    assert.deepEqual(end.ending, {
      kind: 'failed',
      retryable: true,
      reason: 'the out doc plan.md was not read: it is larger than 1048576 bytes',
    });
    assert.equal(read[0]?.maxBytes, 1024 * 1024);
  });

  it('reports progress while the attempt runs, and nothing once it ended', async () => {
    const { runner } = setup({ lines: fixture('success.jsonl').slice(0, 2), hang: true });
    const running = runner.start(attempt);
    await new Promise((settled) => setImmediate(settled));
    assert.deepEqual(runner.progress(attempt.ref), {
      lastProgressAt: at(1),
      turnsWithoutProgress: 1,
    });
    running.stop();
    const end = await running.ended;
    assert.deepEqual(end.ending, { kind: 'cancelled' });
    assert.equal(runner.progress(attempt.ref), undefined);
    assert.equal(runner.progress({ ...attempt.ref, attempt: 2 }), undefined);
  });

  it('cancels an attempt stopped before its process started', async () => {
    let release = (): void => {};
    const { calls, runner } = setup(
      { lines: fixture('success.jsonl'), result: exited(0) },
      {
        plan: () =>
          new Promise((ready) => {
            release = () => ready(plan());
          }),
      },
    );
    const running = runner.start(attempt);
    running.stop();
    release();
    assert.deepEqual((await running.ended).ending, { kind: 'cancelled' });
    assert.deepEqual(calls, []);
  });
});

/**
 * A rename that tries again for a moment: on Windows a scanner may still hold a file just written
 * in the folder, and the rename fails with EPERM, EACCES or EBUSY until it lets go.
 */
const renameRetrying = (from: string, to: string): void => {
  for (let tries = 1; ; tries += 1) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (tries >= 50 || !['EPERM', 'EACCES', 'EBUSY'].includes(code)) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
};

describe('readOutDocFile', () => {
  let dir: TempDir;
  beforeEach(() => {
    dir = makeTempDir('out-doc');
  });
  afterEach(() => dir.remove());

  it('reads an out doc within its limit', () => {
    writeFileSync(join(dir.path, 'plan.md'), 'é done');
    assert.deepEqual(readOutDocFile(join(dir.path, 'plan.md'), 100, dir.path), {
      kind: 'text',
      text: 'é done',
    });
  });

  it('says when there is none', () => {
    assert.deepEqual(readOutDocFile(join(dir.path, 'plan.md'), 100, dir.path), { kind: 'missing' });
  });

  it('does not read an out doc past its limit', () => {
    writeFileSync(join(dir.path, 'plan.md'), 'x'.repeat(101));
    assert.deepEqual(readOutDocFile(join(dir.path, 'plan.md'), 100, dir.path), {
      kind: 'unread',
      reason: 'it is larger than 100 bytes',
    });
  });

  it('does not read what is not a regular file', () => {
    mkdirSync(join(dir.path, 'plan.md'));
    assert.deepEqual(readOutDocFile(join(dir.path, 'plan.md'), 100, dir.path), {
      kind: 'unread',
      reason: 'it is not a regular file',
    });
  });

  // A link in a folder of the path (a junction, which needs no privilege) leads out as well.
  // A hard link keeps its name inside the worktree but its content may be any file of the volume.
  // #134: the file opened must be the file checked, not one swapped in between.
  // Review of #136: a folder swapped for a link between the check and the open is followed by
  // the open and by any later look at the same path; only the identity taken at the check holds.
  it('does not read the file behind a folder swapped in after the check', () => {
    const worktree = join(dir.path, 'worktree');
    mkdirSync(join(worktree, 'docs'), { recursive: true });
    mkdirSync(join(dir.path, 'outside'));
    writeFileSync(join(worktree, 'docs', 'plan.md'), 'the out doc');
    writeFileSync(join(dir.path, 'outside', 'plan.md'), 'not for the log');
    const swapping = (path: string, flags: number): number => {
      renameRetrying(join(worktree, 'docs'), join(worktree, 'docs-before'));
      symlinkSync(join(dir.path, 'outside'), join(worktree, 'docs'), 'junction');
      return openSync(path, flags);
    };
    assert.deepEqual(readOutDocFile(join(worktree, 'docs', 'plan.md'), 100, worktree, swapping), {
      kind: 'unread',
      reason: 'it changed while it was read',
    });
  });

  // Review of #136: a swap after the containment check but before the identity is taken is seen
  // once more after the open, when the real path no longer is the one checked.
  it('does not read the file behind a folder swapped in before its identity was taken', () => {
    const worktree = join(dir.path, 'worktree');
    mkdirSync(join(worktree, 'docs'), { recursive: true });
    mkdirSync(join(dir.path, 'outside'));
    writeFileSync(join(worktree, 'docs', 'plan.md'), 'the out doc');
    writeFileSync(join(dir.path, 'outside', 'plan.md'), 'not for the log');
    const swapping = (path: string, options: { bigint: true }) => {
      renameRetrying(join(worktree, 'docs'), join(worktree, 'docs-before'));
      symlinkSync(join(dir.path, 'outside'), join(worktree, 'docs'), 'junction');
      return statSync(path, options);
    };
    const file = join(worktree, 'docs', 'plan.md');
    assert.deepEqual(readOutDocFile(file, 100, worktree, openSync, swapping), {
      kind: 'unread',
      reason: 'it changed while it was read',
    });
  });

  it('does not read a file other than the one it checked', () => {
    writeFileSync(join(dir.path, 'plan.md'), 'the out doc');
    writeFileSync(join(dir.path, 'swapped.md'), 'not for the log');
    const swapped = (_path: string, flags: number): number =>
      openSync(join(dir.path, 'swapped.md'), flags);
    assert.deepEqual(readOutDocFile(join(dir.path, 'plan.md'), 100, dir.path, swapped), {
      kind: 'unread',
      reason: 'it changed while it was read',
    });
  });

  it('does not read an out doc that has more than one link', () => {
    writeFileSync(join(dir.path, 'secret.txt'), 'not for the log');
    linkSync(join(dir.path, 'secret.txt'), join(dir.path, 'plan.md'));
    assert.deepEqual(readOutDocFile(join(dir.path, 'plan.md'), 100, dir.path), {
      kind: 'unread',
      reason: 'it has more than one link',
    });
  });

  it('does not read an out doc outside the worktree, through a linked folder or ..', () => {
    const worktree = join(dir.path, 'worktree');
    mkdirSync(worktree);
    mkdirSync(join(dir.path, 'outside'));
    writeFileSync(join(dir.path, 'outside', 'plan.md'), 'not for the log');
    symlinkSync(join(dir.path, 'outside'), join(worktree, 'out'), 'junction');
    for (const file of [
      join(worktree, 'out', 'plan.md'),
      join(worktree, '..', 'outside', 'plan.md'),
    ]) {
      assert.deepEqual(
        readOutDocFile(file, 100, worktree),
        {
          kind: 'unread',
          reason: 'it is outside the worktree',
        },
        file,
      );
    }
  });

  // ADR 0047: a link could point the out doc, and so the event log, at any file.
  it('does not read an out doc that is a link to a file', (t) => {
    writeFileSync(join(dir.path, 'secret.txt'), 'not for the log');
    try {
      symlinkSync(join(dir.path, 'secret.txt'), join(dir.path, 'plan.md'), 'file');
    } catch {
      // Windows makes a link to a file only with a privilege the test may not have.
      t.skip('cannot make a link to a file here');
      return;
    }
    assert.deepEqual(readOutDocFile(join(dir.path, 'plan.md'), 100, dir.path), {
      kind: 'unread',
      reason: 'it is not a regular file',
    });
  });
});

describe('clearOutDocFile (ADR 0118)', () => {
  let dir: TempDir;
  beforeEach(() => {
    dir = makeTempDir('clear-out-doc');
  });
  afterEach(() => dir.remove());

  it('removes the out doc a run before left, and does nothing when there is none', () => {
    writeFileSync(join(dir.path, 'plan.md'), 'needs input');
    clearOutDocFile(join(dir.path, 'plan.md'), dir.path);
    assert.equal(existsSync(join(dir.path, 'plan.md')), false);
    clearOutDocFile(join(dir.path, 'plan.md'), dir.path);
  });

  // A brewer can make a folder of the out doc's path a link out of its worktree.
  it('removes nothing outside the worktree, through a linked folder or ..', () => {
    const worktree = join(dir.path, 'worktree');
    mkdirSync(worktree);
    mkdirSync(join(dir.path, 'outside'));
    writeFileSync(join(dir.path, 'outside', 'plan.md'), 'not the worktree');
    symlinkSync(join(dir.path, 'outside'), join(worktree, 'out'), 'junction');
    for (const file of [
      join(worktree, 'out', 'plan.md'),
      join(worktree, '..', 'outside', 'plan.md'),
    ]) {
      assert.throws(() => clearOutDocFile(file, worktree), /outside the worktree/, file);
    }
    assert.equal(existsSync(join(dir.path, 'outside', 'plan.md')), true);
  });
});

// The runner's real wait before it starts claude once more (ADR 0048).
describe('waitFor', () => {
  it('resolves after its time', async () => {
    const started = performance.now();
    await waitFor(20, new AbortController().signal);
    assert.ok(performance.now() - started >= 15);
  });

  // The clock stands still, so only the abort can end the wait, and it ends before the event loop
  // turns once more: no wall time to compare, so load cannot fail it (ADR 0070).
  it('resolves at once when the signal aborts, before its time', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const stop = new AbortController();
    const waited = waitFor(60_000, stop.signal);
    stop.abort();
    // A loaded machine takes the CPU away for a while (#147).
    descheduled(1100);
    const first = await Promise.race([
      waited.then(() => 'resolved' as const),
      new Promise<'not yet'>((answer) => setImmediate(() => answer('not yet'))),
    ]);
    assert.equal(first, 'resolved');
  });

  // Review of #136: a stop that came before the wait began must not cost the wait.
  // Review of #136: a wait cut short leaves no timer behind.
  it('clears its timer when the signal aborts', async () => {
    const cleared: unknown[] = [];
    const timers = {
      set: (_callback: () => void, _ms: number) => 'the timer',
      clear: (timer: unknown) => {
        cleared.push(timer);
      },
    };
    const stop = new AbortController();
    const waited = waitFor(60_000, stop.signal, timers);
    stop.abort();
    await waited;
    assert.deepEqual(cleared, ['the timer']);
  });

  it('resolves at once when the signal had already aborted', async () => {
    const stop = new AbortController();
    stop.abort();
    const late = new Promise<'late'>((answer) => {
      setTimeout(() => answer('late'), 1000).unref();
    });
    const first = await Promise.race([
      waitFor(60_000, stop.signal).then(() => 'now' as const),
      late,
    ]);
    assert.equal(first, 'now');
  });
});
