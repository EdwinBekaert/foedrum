// The real brewer runner's shell (#11, ADR 0047) with a fake stream process that plays the
// captured streams of #17: what it starts, what it writes, and how each attempt ends.

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { attemptSettings } from '../../src/brewers/attempt-settings.ts';
import { claudeArgs } from '../../src/brewers/claude-command.ts';
import {
  type ClaudeAttemptPlan,
  type ClaudeRunnerDeps,
  claudeBrewerRunnerWith,
  readOutDocFile,
} from '../../src/brewers/claude-runner.ts';
import { assembleBrewerPrompt, type BrewerPrompt } from '../../src/brewers/prompt.ts';
import type { AttemptLimits, AttemptStart } from '../../src/engine/brewer-runner.ts';
import type { StreamOptions, StreamResult } from '../../src/platform/processes.ts';
import type { AttemptSettings } from '../../src/schemas/attempt-settings.ts';
import { OutDocFrontmatter } from '../../src/schemas/out-doc.ts';
import { outDoc } from '../helpers/fake-brewer-runner.ts';
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
  permissions: { allow: tools, deny: [], sandbox: false },
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
  play: Play,
  more: {
    plan?: () => Promise<ClaudeAttemptPlan>;
    outDoc?: string | undefined | { unread: string };
  } = {},
) => {
  const calls: Call[] = [];
  const written: { file: string; settings: AttemptSettings }[] = [];
  const read: { file: string; maxBytes: number }[] = [];
  let clock = 0;
  const deps: ClaudeRunnerDeps = {
    claude: '/opt/claude/bin/claude',
    plan: more.plan ?? (async () => plan()),
    stream: async (file, args, options) => {
      calls.push({ file, args, options });
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
      readOutDoc: (file, maxBytes) => {
        read.push({ file, maxBytes });
        const text = 'outDoc' in more ? more.outDoc : done;
        if (text === undefined) return { kind: 'missing' };
        if (typeof text === 'object') return { kind: 'unread', reason: text.unread };
        return { kind: 'text', text };
      },
    },
    now: () => {
      clock += 1;
      return at(clock);
    },
  };
  return { calls, written, read, runner: claudeBrewerRunnerWith(deps) };
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

  it('succeeds with the out doc, the usage and the session of a clean run', async () => {
    const { read, runner } = setup({ lines: fixture('success.jsonl'), result: exited(0) });
    const end = await runner.start(attempt).ended;
    assert.deepEqual(end, {
      ending: {
        kind: 'succeeded',
        output: { status: 'done', summary: 'Planned', assumptions: [] },
      },
      usage: { inputTokens: 2, outputTokens: 4, cacheReadTokens: 1670, cacheWriteTokens: 2452 },
      session: { sessionId: session(1), model: 'claude-haiku-5-5', claudeVersion: '2.1.301' },
    });
    assert.deepEqual(
      read.map((r) => r.file),
      [resolve('/work/tree', 'plan.md')],
    );
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
    assert.ok(calls.every((call) => call.options.signal?.aborted));
  });
});

describe('readOutDocFile', () => {
  let dir: TempDir;
  beforeEach(() => {
    dir = makeTempDir('out-doc');
  });
  afterEach(() => dir.remove());

  it('reads an out doc within its limit', () => {
    writeFileSync(join(dir.path, 'plan.md'), 'é done');
    assert.deepEqual(readOutDocFile(join(dir.path, 'plan.md'), 100), {
      kind: 'text',
      text: 'é done',
    });
  });

  it('says when there is none', () => {
    assert.deepEqual(readOutDocFile(join(dir.path, 'plan.md'), 100), { kind: 'missing' });
  });

  it('does not read an out doc past its limit', () => {
    writeFileSync(join(dir.path, 'plan.md'), 'x'.repeat(101));
    assert.deepEqual(readOutDocFile(join(dir.path, 'plan.md'), 100), {
      kind: 'unread',
      reason: 'it is larger than 100 bytes',
    });
  });

  it('does not read what is not a regular file', () => {
    mkdirSync(join(dir.path, 'plan.md'));
    assert.deepEqual(readOutDocFile(join(dir.path, 'plan.md'), 100), {
      kind: 'unread',
      reason: 'it is not a regular file',
    });
  });
});
