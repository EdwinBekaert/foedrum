// The user's own Claude Code settings must not widen a brewer (#11, ADR 0045): the runner passes
// `--setting-sources ""`, so the only settings file is its own `--settings`. Proven against the
// installed `claude` with a throwaway user settings folder (CLAUDE_CONFIG_DIR) and a fake
// Messages API, so it needs no login and spends no tokens; skipped where `claude` is not on PATH.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { attemptSettings, writeAttemptSettings } from '../../src/brewers/attempt-settings.ts';
import { claudeArgs } from '../../src/brewers/claude-command.ts';
import { checkInit } from '../../src/brewers/claude-init.ts';
import { resolveExecutable } from '../../src/platform/executables.ts';
import { streamProcess } from '../../src/platform/processes.ts';
import { removeTree } from '../../src/platform/remove.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';
import { type FakeMessagesApi, startFakeMessagesApi } from './fake-messages-api.ts';

const claude = resolveExecutable('claude');

// The command the fake model runs: it needs an allow rule (unlike `echo`, which Claude Code
// allows as read-only), and it prints a variable that only the user's settings set.
const probe = `node -e "process.stdout.write('probe:' + (process.env.FOEDRUM_USER_ENV ?? 'unset'))"`;

interface StreamEvent {
  type: string;
  subtype?: string;
  tool_name?: string;
  message?: { content?: { type: string; content?: unknown; is_error?: boolean }[] };
}

/** What the brewer's tool call came to: denied, or what the command printed; and the init. */
interface Outcome {
  denied: string[];
  printed: string[];
  init: unknown;
  sessionId: string;
}

/** Writes an attempt settings file with these allow rules and no deny rules. */
const rules =
  (allow: string[]) =>
  (file: string): void =>
    writeFileSync(file, JSON.stringify({ permissions: { allow, deny: [] } }));

describe('claude and the user settings', { skip: claude === undefined }, () => {
  let dir: TempDir;
  let api: FakeMessagesApi;
  beforeEach(async () => {
    dir = makeTempDir('claude-settings');
    api = await startFakeMessagesApi({ name: 'Bash', input: { command: probe } });
    // The throwaway user settings: an allow rule for any command, and a variable of their own.
    mkdirSync(join(dir.path, 'user'));
    writeFileSync(
      join(dir.path, 'user', 'settings.json'),
      JSON.stringify({
        permissions: { allow: ['Bash(*)'] },
        env: { FOEDRUM_USER_ENV: 'widened' },
      }),
    );
    mkdirSync(join(dir.path, 'worktree'));
  });
  afterEach(async () => {
    await api.close();
    removeTree(dir.path);
  });

  /** Runs the brewer's command line with the attempt settings that `write` writes. */
  const run = async (
    write: (file: string) => void,
    args: (all: string[]) => string[] = (all) => all,
  ): Promise<Outcome> => {
    const settingsFile = join(dir.path, 'attempt-settings.json');
    write(settingsFile);
    const sessionId = randomUUID();
    const all = claudeArgs({
      model: 'claude-haiku-5-5',
      effort: 'low',
      maxTurns: 3,
      settingsFile,
      tools: ['Read', 'Bash'],
      session: { kind: 'new', id: sessionId },
    });
    // Nothing of the developer's own Claude Code reaches the test, and nothing leaves the machine.
    const inherited = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !/^(?:ANTHROPIC_|CLAUDE)/i.test(name)),
    );
    const lines: string[] = [];
    const result = await streamProcess(claude ?? 'claude', args(all), {
      cwd: join(dir.path, 'worktree'),
      env: {
        ...inherited,
        CLAUDE_CONFIG_DIR: join(dir.path, 'user'),
        ANTHROPIC_BASE_URL: api.url,
        ANTHROPIC_API_KEY: 'sk-ant-test-not-a-key',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        DISABLE_TELEMETRY: '1',
      },
      stdin: 'Run the probe.',
      maxLineBytes: 1024 * 1024,
      timeoutMs: 120_000,
      jobObject: true,
      onLine: (line) => lines.push(line),
    });
    assert.equal(result.exitCode, 0, result.stderr);
    const events = lines.map((line) => JSON.parse(line) as StreamEvent);
    return {
      denied: events
        .filter((e) => e.type === 'system' && e.subtype === 'permission_denied')
        .map((e) => e.tool_name ?? ''),
      printed: events
        .filter((e) => e.type === 'user')
        .flatMap((e) => e.message?.content ?? [])
        // A denied call's result is an error that quotes the command, not what it printed.
        .filter((block) => block.type === 'tool_result' && block.is_error !== true)
        .map((block) => JSON.stringify(block.content))
        .filter((content) => content.includes('probe:')),
      // claude may send other system events first (ui_invalidate, seen with an API key).
      init: events.find((e) => !(e.type === 'system' && e.subtype !== 'init')),
      sessionId,
    };
  };

  const withoutSettingSources = (args: string[]): string[] => {
    const at = args.indexOf('--setting-sources');
    return [...args.slice(0, at), ...args.slice(at + 2)];
  };

  // Without this the test would prove nothing: the throwaway file is read, and it widens.
  it('reads the throwaway user settings when the sources are left to claude', async () => {
    const outcome = await run(rules(['Read']), withoutSettingSources);
    assert.deepEqual(outcome.denied, []);
    assert.equal(outcome.printed.length, 1);
    assert.match(outcome.printed[0] ?? '', /probe:widened/);
  });

  it("does not let the user's allow rules allow a command the brewer may not run", async () => {
    const outcome = await run(rules(['Read']));
    assert.deepEqual(outcome.denied, ['Bash']);
    assert.deepEqual(outcome.printed, []);
  });

  it("does not give the brewer the user's variables", async () => {
    const outcome = await run(rules(['Read', 'Bash(node *)']));
    assert.deepEqual(outcome.denied, []);
    assert.equal(outcome.printed.length, 1);
    assert.match(outcome.printed[0] ?? '', /probe:unset/);
  });

  // The init check of ADR 0045 against the real CLI: what it reports is what the runner asked.
  it('sets up the session the runner asked for, as its init event shows', async () => {
    const settings = attemptSettings({ allow: ['Read'], deny: [], sandbox: false });
    const outcome = await run((file) => writeAttemptSettings(file, settings));
    const check = checkInit(outcome.init, {
      sessionId: outcome.sessionId,
      tools: ['Read', 'Bash'],
    });
    assert.equal(check.kind, 'matches', JSON.stringify(check));
  });

  // ADR 0042's contract test: claude reads the file the runner writes, deny rules included.
  it('applies a deny rule of the settings file the runner wrote', async () => {
    const settings = attemptSettings({
      allow: ['Read', 'Bash(node *)'],
      deny: ['Bash(node -e *)'],
      sandbox: false,
    });
    const outcome = await run((file) => writeAttemptSettings(file, settings));
    assert.deepEqual(outcome.denied, ['Bash']);
    assert.deepEqual(outcome.printed, []);
  });
});
