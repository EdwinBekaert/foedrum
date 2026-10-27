// What the claude runner reports of a running attempt for the live line of `foedrum brew`
// (ADR 0174): `settingUp` from the runner itself while the repository's setup runs, and the turn,
// the latest tool and the denial from the stream reader once claude runs, with the attempt's
// worktree given to the reader (a fake stream process and fake files; no process starts).

import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { type ClaudeAttemptPlan, claudeBrewerRunnerWith } from '../../src/brewers/claude-runner.ts';
import { assembleBrewerPrompt } from '../../src/brewers/prompt.ts';
import type { AttemptLimits, AttemptStart } from '../../src/engine/brewer-runner.ts';
import type { ExecProcess } from '../../src/platform/processes.ts';
import { OutDocFrontmatter } from '../../src/schemas/out-doc.ts';

const session = '00000000-0000-4000-8000-000000000001';
const worktree = resolve('work', 'tree');
const assembled = assembleBrewerPrompt('Plan the change.', []);
if (assembled.kind !== 'assembled') throw new Error('the test prompt was refused');

const limits: AttemptLimits = {
  outDoc: { file: 'plan.md', schema: OutDocFrontmatter },
  maxTurns: 30,
  maxDenials: 5,
};
const attempt: AttemptStart = { ref: { batchId: '21-1', stepId: 'plan', attempt: 1 }, limits };

const plan = (withSetup: boolean): ClaudeAttemptPlan => ({
  cwd: worktree,
  env: { PATH: '/usr/bin' },
  prompt: assembled.prompt,
  call: {
    model: 'claude-haiku-5-5',
    effort: 'low',
    maxTurns: 30,
    tools: ['Read'],
    session: { kind: 'new', id: session },
  },
  permissions: { allow: ['Read'], deny: [], sandbox: false },
  settingsFile: join(worktree, '..', 'settings.json'),
  ...(withSetup
    ? {
        setup: {
          run: { command: 'npm ci', timeoutMs: 600_000, unsandboxed: false },
          deadlineAt: '2026-10-24T13:00:00.000Z',
          env: { PATH: '/usr/bin' },
        },
      }
    : {}),
});

const init = JSON.stringify({
  type: 'system',
  subtype: 'init',
  session_id: session,
  tools: ['Read'],
  mcp_servers: [],
  model: 'claude-haiku-5-5',
  permissionMode: 'dontAsk',
  slash_commands: [],
  skills: [],
  claude_code_version: '2.1.301',
});
const reads = (file: string): string =>
  JSON.stringify({
    type: 'assistant',
    message: {
      id: 'msg_1',
      role: 'assistant',
      content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: file } }],
    },
    parent_tool_use_id: null,
    session_id: session,
  });
const denied = JSON.stringify({
  type: 'system',
  subtype: 'permission_denied',
  tool_name: 'Read',
  tool_use_id: 't1',
});

/**
 * A runner whose claude writes `lines`, then runs until stopped. Its setup, when the plan has one,
 * runs until stopped, or passes at once when `setupPasses`.
 */
const runnerOf = (lines: readonly string[], withSetup: boolean, setupPasses = false) => {
  let setupStarted: () => void = () => {};
  const setupRuns = new Promise<void>((started) => {
    setupStarted = started;
  });
  const setup: ExecProcess = (_file, _args, options) => {
    setupStarted();
    if (setupPasses) {
      return Promise.resolve({ exitCode: 0, stdout: 'added 7 packages', stderr: '', output: '' });
    }
    return new Promise((done) =>
      options.signal?.addEventListener('abort', () =>
        done({ exitCode: null, stdout: '', stderr: '', output: '', killed: 'stopped' }),
      ),
    );
  };
  let claudeStarted: () => void = () => {};
  const claudeWrote = new Promise<void>((started) => {
    claudeStarted = started;
  });
  const runner = claudeBrewerRunnerWith({
    claude: '/opt/claude/bin/claude',
    plan: async () => plan(withSetup),
    stream: async (_file, _args, options) => {
      for (const line of lines) options.onLine(line);
      claudeStarted();
      return new Promise((done) =>
        options.signal?.addEventListener('abort', () =>
          done({ exitCode: null, stderr: '', killed: 'stopped' }),
        ),
      );
    },
    setup,
    files: {
      writeSettings: () => {},
      writeSystemPrompt: () => {},
      readOutDoc: () => ({ kind: 'missing' }),
      clearOutDoc: () => {},
      restoreOutDoc: () => {},
      copyOutDoc: () => {},
    },
    now: () => new Date('2026-10-24T12:00:00.000Z'),
    wait: () => Promise.resolve(),
    commits: async () => ({ kind: 'counted', count: 0 }),
    scan: async () => ({ kind: 'scanned', findings: [] }),
    touches: async (_clone, _commit, paths) => ({ kind: 'read', present: new Set(paths) }),
  });
  return { runner, setupRuns, claudeWrote };
};

describe('claudeBrewerRunner progress for the live line', () => {
  it('says it sets up while the setup of the repository runs, with no turn and no tool yet', async () => {
    const { runner, setupRuns } = runnerOf([init, reads('a.ts')], true);
    const running = runner.start(attempt);
    await setupRuns;
    const progress = runner.progress(attempt.ref);
    assert.equal(progress?.settingUp, true);
    assert.equal(progress?.turn, undefined);
    assert.equal(progress?.lastTool, undefined);
    running.stop();
    await running.ended;
  });

  it('reports the turn, the latest tool as a path relative to the worktree of the attempt, and a denial', async () => {
    const { runner, claudeWrote } = runnerOf(
      [init, reads(join(worktree, 'src', 'a.ts')), denied],
      false,
    );
    const running = runner.start(attempt);
    await claudeWrote;
    const progress = runner.progress(attempt.ref);
    assert.equal(progress?.turn, 1);
    assert.deepEqual(progress?.lastTool, { name: 'Read', word: 'src/a.ts' });
    assert.equal(progress?.denied, true);
    assert.notEqual(progress?.settingUp, true);
    running.stop();
    await running.ended;
  });

  it('stops saying it sets up once the setup passed and claude runs', async () => {
    const { runner, claudeWrote } = runnerOf([init, reads('a.ts')], true, true);
    const running = runner.start(attempt);
    await claudeWrote;
    const progress = runner.progress(attempt.ref);
    assert.equal(progress?.turn, 1);
    assert.notEqual(progress?.settingUp, true);
    running.stop();
    await running.ended;
  });
});
