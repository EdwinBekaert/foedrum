// The real brewer runner against the installed `claude` (#11, ADR 0047): a fake Messages API
// stands in for the model, so the test needs no login and spends no tokens. Its "model" makes
// one tool call, then answers. Opt-in: it runs only with FOEDRUM_REAL_CLAUDE=1 (ADR 0057).

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { type ClaudeAttemptPlan, claudeBrewerRunner } from '../../src/brewers/claude-runner.ts';
import { assembleBrewerPrompt } from '../../src/brewers/prompt.ts';
import type { AttemptStart } from '../../src/engine/brewer-runner.ts';
import { removeTree } from '../../src/platform/remove.ts';
import { OutDocFrontmatter } from '../../src/schemas/out-doc.ts';
import { outDoc } from '../helpers/fake-brewer-runner.ts';
import { realClaude } from '../helpers/real-claude.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';
import { type FakeMessagesApi, startFakeMessagesApi } from './fake-messages-api.ts';

const real = realClaude();

describe('the claude brewer runner', { skip: real.kind === 'skip' && real.reason }, () => {
  let dir: TempDir;
  let api: FakeMessagesApi | undefined;
  let worktree: string;
  beforeEach(() => {
    dir = makeTempDir('claude-runner');
    worktree = join(dir.path, 'worktree');
    mkdirSync(worktree);
    mkdirSync(join(dir.path, 'user'));
    mkdirSync(join(dir.path, 'attempt'));
  });
  afterEach(async () => {
    await api?.close();
    removeTree(dir.path);
  });

  const attempt = (maxDenials?: number): AttemptStart => ({
    ref: { batchId: '21-1', stepId: 'plan', attempt: 1 },
    limits: {
      outDoc: { file: 'plan.md', schema: OutDocFrontmatter },
      maxTurns: 5,
      ...(maxDenials === undefined ? {} : { maxDenials }),
    },
  });

  /** Runs one attempt whose model writes `plan.md`, with these allow rules. */
  const run = async (allow: string[], maxDenials?: number) => {
    const doc = outDoc({ status: 'done', summary: 'Planned' });
    api = await startFakeMessagesApi({
      name: 'Write',
      input: { file_path: join(worktree, 'plan.md'), content: doc },
    });
    const assembled = assembleBrewerPrompt('Write the plan.', []);
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
      permissions: { allow, deny: [], sandbox: false },
      settingsFile: join(dir.path, 'attempt', 'settings.json'),
    };
    const runner = claudeBrewerRunner({
      claude: real.kind === 'run' ? real.claude : 'claude',
      plan: async () => plan,
    });
    const running = runner.start(attempt(maxDenials));
    assert.ok(runner.progress(attempt().ref), 'reports the attempt while it runs');
    const end = await running.ended;
    assert.equal(runner.progress(attempt().ref), undefined);
    return { end, sessionId };
  };

  it('succeeds with the out doc the brewer wrote, and records its session', async () => {
    const { end, sessionId } = await run(['Read', 'Write']);
    assert.deepEqual(end.ending, {
      kind: 'succeeded',
      output: { status: 'done', summary: 'Planned', assumptions: [] },
    });
    assert.equal(end.session?.sessionId, sessionId);
    assert.equal(end.session?.model, 'claude-haiku-5-5');
    assert.ok(end.usage !== undefined, 'reports the usage');
  });

  it('stops the brewer at the denial that reaches maxDenials, naming the tool', async () => {
    const { end } = await run(['Read'], 1);
    assert.deepEqual(end.ending, {
      kind: 'blocked',
      blockerKind: 'environment',
      summary: '1 permission denials, maxDenials is 1; denied: Write',
    });
  });
});
