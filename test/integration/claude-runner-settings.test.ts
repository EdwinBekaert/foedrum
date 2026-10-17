// The runner's attempt settings and init check against the installed `claude` (ADR 0042, ADR
// 0046): the settings file `writeAttemptSettings` writes, with its deny rules, and the session
// `checkInit` expects. A fake Messages API stands in for the model, whose one tool call runs a
// `node -e` command through Bash, so the test needs no login and spends no tokens. Opt-in: it
// runs only with FOEDRUM_REAL_CLAUDE=1 (ADR 0057).

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  type AttemptPermissions,
  attemptSettings,
  writeAttemptSettings,
} from '../../src/brewers/attempt-settings.ts';
import { claudeArgs } from '../../src/brewers/claude-command.ts';
import { checkInit } from '../../src/brewers/claude-init.ts';
import { streamProcess } from '../../src/platform/processes.ts';
import { removeTree } from '../../src/platform/remove.ts';
import { realClaude } from '../helpers/real-claude.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';
import { type FakeMessagesApi, startFakeMessagesApi } from './fake-messages-api.ts';

const real = realClaude();

// The command the fake model runs: it needs an allow rule (unlike `echo`, which Claude Code
// allows as read-only).
const probe = `node -e "process.stdout.write('probe:ran')"`;

type Shell = 'Bash' | 'PowerShell';

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

describe('claude with the runner settings', { skip: real.kind === 'skip' && real.reason }, () => {
  let dir: TempDir;
  beforeEach(() => {
    dir = makeTempDir('claude-runner-settings');
    // An empty user settings folder, so nothing of the developer's own Claude Code is read.
    mkdirSync(join(dir.path, 'user'));
    mkdirSync(join(dir.path, 'worktree'));
  });
  afterEach(() => removeTree(dir.path));

  /**
   * Runs the brewer's command line with the attempt settings the runner writes for these
   * permissions; the fake model runs `command` in `shell`.
   */
  const run = async (
    permissions: AttemptPermissions,
    command = probe,
    shell: Shell = 'Bash',
  ): Promise<Outcome> => {
    const api = await startFakeMessagesApi({ name: shell, input: { command } });
    try {
      return await runWith(api, permissions, shell);
    } finally {
      await api.close();
    }
  };

  const runWith = async (
    api: FakeMessagesApi,
    permissions: AttemptPermissions,
    shell: Shell,
  ): Promise<Outcome> => {
    const settingsFile = join(dir.path, 'attempt-settings.json');
    writeAttemptSettings(settingsFile, attemptSettings(permissions));
    const sessionId = randomUUID();
    const args = claudeArgs({
      model: 'claude-haiku-5-5',
      effort: 'low',
      maxTurns: 3,
      settingsFile,
      tools: ['Read', shell],
      session: { kind: 'new', id: sessionId },
    });
    // Nothing of the developer's own Claude Code reaches the test, and nothing leaves the machine.
    const inherited = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !/^(?:ANTHROPIC_|CLAUDE)/i.test(name)),
    );
    const lines: string[] = [];
    const result = await streamProcess(real.kind === 'run' ? real.claude : 'claude', args, {
      cwd: join(dir.path, 'worktree'),
      env: {
        ...inherited,
        CLAUDE_CONFIG_DIR: join(dir.path, 'user'),
        ANTHROPIC_BASE_URL: api.url,
        ANTHROPIC_API_KEY: 'sk-ant-test-not-a-key',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        DISABLE_TELEMETRY: '1',
        // Off by default where Git Bash is installed, for some accounts (docs: Tools, PowerShell).
        ...(shell === 'PowerShell' ? { CLAUDE_CODE_USE_POWERSHELL_TOOL: '1' } : {}),
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

  // The init check of ADR 0046: what claude reports is what the runner asked.
  it('sets up the session the runner asked for, as its init event shows', async () => {
    const outcome = await run({ allow: ['Read'], deny: [], sandbox: false });
    const check = checkInit(outcome.init, {
      sessionId: outcome.sessionId,
      tools: ['Read', 'Bash'],
    });
    assert.equal(check.kind, 'matches', JSON.stringify(check));
  });

  // ADR 0042's contract test: claude reads the file the runner writes, deny rules included.
  it('applies a deny rule of the settings file the runner wrote', async () => {
    const outcome = await run({
      allow: ['Read', 'Bash(node *)'],
      deny: ['Bash(node -e *)'],
      sandbox: false,
    });
    assert.deepEqual(outcome.denied, ['Bash']);
    assert.deepEqual(outcome.printed, []);
  });

  // #167, ADR 0062: a deny rule matches the command as written, so a push with git's options
  // before the subcommand is denied only because no allow rule the runner writes reaches it.
  const pushes = [
    'git -C . push',
    'git -c x=y push origin',
    'git --git-dir=.git push',
    "git p''ush",
  ];
  // The PowerShell tool needs PowerShell 7 outside Windows; these machines need not have it.
  const shells: Shell[] = process.platform === 'win32' ? ['Bash', 'PowerShell'] : ['Bash'];
  for (const shell of shells) {
    const gitSubcommands: AttemptPermissions = {
      allow: ['Read', `${shell}(git status *)`, `${shell}(git commit *)`],
      deny: [],
      sandbox: false,
    };
    // The control: the same rules let an allowed subcommand run, so a denial below is theirs.
    // `echo` is read-only, which claude allows by itself; it shows the command really ran.
    it(`runs git status in ${shell} for a brewer allowed git subcommands`, async () => {
      const outcome = await run(gitSubcommands, 'git status; echo probe:ran', shell);
      assert.deepEqual(outcome.denied, []);
      assert.equal(outcome.printed.length, 1, 'the command printed nothing');
    });
    for (const push of pushes) {
      it(`denies ${push} in ${shell} to a brewer allowed git subcommands`, async () => {
        const outcome = await run(gitSubcommands, push, shell);
        assert.deepEqual(outcome.denied, [shell]);
      });
    }
  }
});
