// The file-tool rules of the attempt settings with the installed `claude` (opt-in,
// FOEDRUM_REAL_CLAUDE=1; ADR 0057): the settings file `attemptSettings` writes for a brewer with
// bare `Read`, `Edit` and `Write` rules, on the runner's command line with `--safe-mode`, lets the
// fake model write inside its worktree and nowhere else: not outside, not through `..`, not
// through a junction or link that leads outside (ADR 0093). The rules themselves are unit tests in
// test/unit/attempt-settings.test.ts.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { attemptSettings, writeAttemptSettings } from '../../src/brewers/attempt-settings.ts';
import { claudeArgs } from '../../src/brewers/claude-command.ts';
import { streamProcess } from '../../src/platform/processes.ts';
import { removeTree } from '../../src/platform/remove.ts';
import { realClaude } from '../helpers/real-claude.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';
import { startFakeMessagesApi, type ToolCall } from './fake-messages-api.ts';

const real = realClaude();

interface StreamEvent {
  type: string;
  subtype?: string;
  tool_name?: string;
}

describe('claude with the attempt settings of a brewer with bare file tools', {
  skip: real.kind === 'skip' && real.reason,
}, () => {
  let dir: TempDir;
  let worktree: string;
  let outside: string;
  beforeEach(() => {
    dir = makeTempDir('claude-file-rules');
    worktree = join(dir.path, 'worktree');
    outside = join(dir.path, 'outside');
    // An empty user settings folder, so nothing of the developer's own Claude Code is read.
    for (const folder of [worktree, outside, join(dir.path, 'user')]) mkdirSync(folder);
  });
  afterEach(() => removeTree(dir.path));

  /** Runs the brewer's command line; the fake model makes these calls. Returns the denied tools. */
  const run = async (calls: readonly ToolCall[]): Promise<string[]> => {
    const api = await startFakeMessagesApi(calls);
    try {
      const settingsFile = join(dir.path, 'attempt-settings.json');
      writeAttemptSettings(
        settingsFile,
        attemptSettings({ allow: ['Read', 'Edit', 'Write'], deny: [], sandbox: false }),
      );
      const args = claudeArgs({
        model: 'claude-haiku-5-5',
        effort: 'low',
        maxTurns: calls.length + 2,
        settingsFile,
        tools: ['Read', 'Edit', 'Write'],
        session: { kind: 'new', id: randomUUID() },
      });
      // Nothing of the developer's own Claude Code reaches the test, and nothing leaves the machine.
      const inherited = Object.fromEntries(
        Object.entries(process.env).filter(([name]) => !/^(?:ANTHROPIC_|CLAUDE)/i.test(name)),
      );
      const lines: string[] = [];
      const result = await streamProcess(real.kind === 'run' ? real.claude : 'claude', args, {
        cwd: worktree,
        env: {
          ...inherited,
          CLAUDE_CONFIG_DIR: join(dir.path, 'user'),
          ANTHROPIC_BASE_URL: api.url,
          ANTHROPIC_API_KEY: 'sk-ant-test-not-a-key',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          DISABLE_TELEMETRY: '1',
        },
        stdin: 'Write the files.',
        maxLineBytes: 1024 * 1024,
        timeoutMs: 120_000,
        jobObject: true,
        onLine: (line) => lines.push(line),
      });
      assert.equal(result.exitCode, 0, result.stderr);
      return lines
        .map((line) => JSON.parse(line) as StreamEvent)
        .filter((e) => e.type === 'system' && e.subtype === 'permission_denied')
        .map((e) => e.tool_name ?? '');
    } finally {
      await api.close();
    }
  };

  const write = (file_path: string): ToolCall => ({
    name: 'Write',
    input: { file_path, content: 'written' },
  });
  // Edit needs the file read first; a read outside the worktree is denied too, so Edit cannot
  // reach a file outside by that road. An empty old_string makes Edit create the file.
  const edit = (file_path: string): ToolCall => ({
    name: 'Edit',
    input: { file_path, old_string: '', new_string: 'edited' },
  });

  it('allows Write and Edit inside the worktree', async () => {
    const existing = join(worktree, 'existing.txt');
    writeFileSync(existing, 'before');
    const denied = await run([
      write(join(worktree, 'written.txt')),
      { name: 'Read', input: { file_path: existing } },
      {
        name: 'Edit',
        input: { file_path: existing, old_string: 'before', new_string: 'after' },
      },
      edit(join(worktree, 'created.txt')),
    ]);
    assert.deepEqual(denied, []);
    assert.equal(readFileSync(join(worktree, 'written.txt'), 'utf8'), 'written');
    assert.equal(readFileSync(existing, 'utf8'), 'after');
    assert.equal(readFileSync(join(worktree, 'created.txt'), 'utf8'), 'edited');
  });

  it('denies Write and Edit outside the worktree', async () => {
    const denied = await run([write(join(outside, 'w.txt')), edit(join(outside, 'e.txt'))]);
    assert.deepEqual(denied, ['Write', 'Edit']);
    assert.equal(existsSync(join(outside, 'w.txt')), false);
    assert.equal(existsSync(join(outside, 'e.txt')), false);
  });

  it('denies Write and Edit through ..', async () => {
    const up = `${worktree}/../outside`;
    const denied = await run([write(`${up}/w.txt`), edit(`${up}/e.txt`)]);
    assert.deepEqual(denied, ['Write', 'Edit']);
    assert.equal(existsSync(join(outside, 'w.txt')), false);
    assert.equal(existsSync(join(outside, 'e.txt')), false);
  });

  it('denies Write and Edit through a junction or link that leads outside', async () => {
    const link = join(worktree, 'link');
    symlinkSync(outside, link, 'junction');
    const denied = await run([write(join(link, 'w.txt')), edit(join(link, 'e.txt'))]);
    assert.deepEqual(denied, ['Write', 'Edit']);
    assert.equal(existsSync(join(outside, 'w.txt')), false);
    assert.equal(existsSync(join(outside, 'e.txt')), false);
  });
});
