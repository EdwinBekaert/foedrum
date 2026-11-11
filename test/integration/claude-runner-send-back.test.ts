// The checks before a brewer's end against the installed `claude` (ADR 0381, ADR 0057: opt-in):
// a check that fails sends the brewer back once, by resuming its session, so the model's next call
// holds the conversation before it and the failure as its new message. A fake Messages API stands
// in for the model and a fake check process for the repository's checks, so the test needs no
// login, spends no tokens and runs no toolchain.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { writeAttemptSettings } from '../../src/brewers/attempt-settings.ts';
import {
  type ClaudeAttemptPlan,
  claudeBrewerRunnerWith,
  clearOutDocFile,
  restoreOutDocFile,
  waitFor,
  writeSystemPromptFile,
} from '../../src/brewers/claude-runner.ts';
import { assembleBrewerPrompt } from '../../src/brewers/prompt.ts';
import type { AttemptStart } from '../../src/engine/brewer-runner.ts';
import { readOutDocFile } from '../../src/platform/bounded-read.ts';
import { type ExecResult, streamProcess } from '../../src/platform/processes.ts';
import { removeTree } from '../../src/platform/remove.ts';
import { OutDocFrontmatter } from '../../src/schemas/out-doc.ts';
import { outDoc } from '../helpers/fake-brewer-runner.ts';
import { realClaude } from '../helpers/real-claude.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';
import { type FakeMessagesApi, startFakeMessagesApi } from './fake-messages-api.ts';

const real = realClaude();

describe('the checks before the end with claude', {
  skip: real.kind === 'skip' && real.reason,
}, () => {
  let dir: TempDir;
  let api: FakeMessagesApi | undefined;
  let worktree: string;
  beforeEach(() => {
    dir = makeTempDir('claude-send-back');
    worktree = join(dir.path, 'worktree');
    mkdirSync(worktree);
    mkdirSync(join(dir.path, 'user'));
    mkdirSync(join(dir.path, 'attempt'));
  });
  afterEach(async () => {
    await api?.close();
    removeTree(dir.path);
  });

  it('a failing check sends the brewer back once in the same session', async () => {
    const doc = outDoc({ status: 'done', summary: 'Implemented' });
    // The first run writes its out doc and answers; the resumed run, which already holds that
    // tool's result, answers at once.
    api = await startFakeMessagesApi({
      name: 'Write',
      input: { file_path: join(worktree, 'brew.md'), content: doc },
    });
    const assembled = assembleBrewerPrompt('Make the tests pass.', []);
    if (assembled.kind !== 'assembled') throw new Error('the prompt was refused');
    // Nothing of the developer's own Claude Code reaches the test, and nothing leaves the machine.
    const inherited = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !/^(?:ANTHROPIC_|CLAUDE)/i.test(name)),
    );
    const sessionId = randomUUID();
    const plan: ClaudeAttemptPlan = {
      cwd: worktree,
      env: {
        ...inherited,
        CLAUDE_CONFIG_DIR: join(dir.path, 'user'),
        ANTHROPIC_BASE_URL: api.url,
        ANTHROPIC_API_KEY: 'sk-ant-test-not-a-key',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        DISABLE_TELEMETRY: '1',
      },
      prompt: assembled.prompt,
      call: {
        model: 'claude-haiku-5-5',
        effort: 'low',
        maxTurns: 5,
        tools: ['Read', 'Write'],
        session: { kind: 'new', id: sessionId },
      },
      permissions: { allow: ['Read', 'Write'], deny: [], sandbox: false },
      settingsFile: join(dir.path, 'attempt', 'settings.json'),
      commits: { clone: join(dir.path, 'clone.git'), branch: 'foedrum/21-1/implement/1' },
      sendBack: {
        checks: [{ check: 'lint', command: 'biome lint', files: true }],
        redTests: [],
        deadlineAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        env: { PATH: process.env.PATH ?? '' },
        unsandboxed: false,
      },
    };
    let starts = 0;
    const checked: string[] = [];
    const runner = claudeBrewerRunnerWith({
      claude: real.kind === 'run' ? real.claude : 'claude',
      plan: async () => plan,
      stream: (file, args, options) => {
        starts += 1;
        return streamProcess(file, args, options);
      },
      files: {
        writeSettings: writeAttemptSettings,
        writeSystemPrompt: writeSystemPromptFile,
        readOutDoc: readOutDocFile,
        clearOutDoc: clearOutDocFile,
        restoreOutDoc: restoreOutDocFile,
        copyOutDoc: writeSystemPromptFile,
      },
      now: () => new Date(),
      wait: waitFor,
      commits: async () => ({ kind: 'counted', count: 1 }),
      scan: async () => ({ kind: 'scanned', findings: [] }),
      touches: async (_clone, _commit, paths) => ({ kind: 'read', present: new Set(paths) }),
      changed: async () => ({ kind: 'listed', paths: ['src/a.ts'] }),
      // The lint fails every time: the brewer is sent back once, and its second end stands.
      checks: async (command): Promise<ExecResult> => {
        checked.push(command);
        const output = 'src/a.ts:3 lint-failure-marker\n';
        return { exitCode: 1, stdout: output, stderr: '', output };
      },
    });
    const attempt: AttemptStart = {
      ref: { batchId: '21-1', stepId: 'implement', attempt: 1 },
      limits: {
        outDoc: { file: 'brew.md', schema: OutDocFrontmatter },
        maxTurns: 5,
        commitsSince: 'c'.repeat(40),
      },
    };
    const end = await runner.start(attempt).ended;
    assert.equal(end.ending.kind, 'succeeded', JSON.stringify(end.ending));
    assert.equal(starts, 2);
    assert.deepEqual(checked, ['biome lint "src/a.ts"']);
    assert.equal(end.session?.sessionId, sessionId);
    // The model's last call holds the session before it, and the failure as its new message.
    const last = api.bodies.at(-1) ?? '';
    assert.match(last, /lint-failure-marker/);
    assert.match(last, /"tool_use"/);
    assert.match(last, /Make the tests pass\./);
    assert.ok(
      api.bodies.slice(0, -1).every((body) => !body.includes('lint-failure-marker')),
      'the failure reached the model only after the first run',
    );
  });
});
