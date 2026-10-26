import assert from 'node:assert/strict';
import { win32 } from 'node:path';
import { describe, it } from 'node:test';
import {
  type ClaudeCall,
  claudeArgs,
  interactiveArgs,
  resumeArgs,
} from '../../src/brewers/claude-command.ts';
import { jobObjectCommand, windowsArgument } from '../../src/platform/job-object.ts';
import { spawnCommand } from '../../src/platform/processes.ts';
import { windowsCommandLine } from '../../src/platform/shell.ts';

const call: ClaudeCall = {
  model: 'claude-sonnet-5-5',
  effort: 'high',
  maxTurns: 40,
  settingsFile: '/work/attempt/settings.json',
  tools: ['Read', 'Grep', 'Bash'],
  session: { kind: 'new', id: '6f1c2b9e-4d3a-4e8f-9a7b-1c2d3e4f5a6b' },
};

describe('claudeArgs', () => {
  it("builds ADR 0042's command line, loading no settings of the user or the repository", () => {
    assert.deepEqual(claudeArgs(call), [
      '--print',
      '--verbose',
      '--output-format',
      'stream-json',
      '--permission-mode',
      'dontAsk',
      '--permission-prompts',
      'none',
      '--model',
      'claude-sonnet-5-5',
      '--effort',
      'high',
      '--max-turns',
      '40',
      '--settings',
      '/work/attempt/settings.json',
      // Only the runner's own --settings: no user, project or local settings file (ADR 0046).
      '--setting-sources',
      '',
      '--tools',
      'Read,Grep,Bash',
      '--disable-slash-commands',
      '--strict-mcp-config',
      '--safe-mode',
      '--session-id',
      '6f1c2b9e-4d3a-4e8f-9a7b-1c2d3e4f5a6b',
    ]);
  });

  it('resumes a session instead of starting one', () => {
    const args = claudeArgs({ ...call, session: { kind: 'resume', id: call.session.id } });
    assert.deepEqual(args.slice(-2), ['--resume', call.session.id]);
    assert.equal(args.includes('--session-id'), false);
  });

  it('leaves out --max-turns when the brewer has none, and appends a system prompt file', () => {
    const args = claudeArgs({
      ...call,
      maxTurns: undefined,
      appendSystemPromptFile: '/work/attempt/system.md',
    });
    assert.equal(args.includes('--max-turns'), false);
    assert.deepEqual(args.slice(-2), ['--append-system-prompt-file', '/work/attempt/system.md']);
  });

  // Never a prompt argument, not even `-`: the prompt goes on stdin (ADR 0042).
  it('has no prompt argument', () => {
    const args = claudeArgs(call);
    assert.equal(args.includes('-'), false);
    assert.equal(args.includes('-p'), false);
  });

  // The arguments reach cmd.exe for npm's claude.cmd (ADR 0031); a bad one is a defect upstream.
  for (const [what, bad, named] of [
    ['a tool name with a specifier', { tools: ['Bash(git *)'] }, /tools/],
    ['no tools', { tools: [] }, /tools/],
    ['a session id that is not a UUID', { session: { kind: 'new', id: 'abc' } }, /session/],
    ['a model that starts with a dash', { model: '--dangerously-skip-permissions' }, /model/],
    ['a maxTurns that is not a positive whole number', { maxTurns: 0 }, /maxTurns/],
    ['a maxTurns that is not a whole number', { maxTurns: 1.5 }, /maxTurns/],
  ] as const) {
    it(`refuses ${what}`, () => {
      assert.throws(() => claudeArgs({ ...call, ...bad } as ClaudeCall), named);
    });
  }

  // ADR 0039's helper leaves the program about 6,100 of Windows's 32,767 characters; the prompt
  // never counts, because it goes on stdin.
  it('pins the longest command line, and it fits the Job Object helper', () => {
    const long = (name: string) => win32.join(`C:\\${'d'.repeat(200)}`, `${name}${'f'.repeat(40)}`);
    const tools = [
      'Read',
      'Write',
      'Edit',
      'MultiEdit',
      'NotebookEdit',
      'Glob',
      'Grep',
      'Bash',
      'PowerShell',
      'WebFetch',
      'WebSearch',
      'TodoWrite',
      'Task',
    ];
    const args = claudeArgs({
      model: 'claude-sonnet-5-5[1m]',
      effort: 'xhigh',
      maxTurns: 99_999,
      settingsFile: long('settings'),
      tools,
      session: { kind: 'resume', id: call.session.id },
      appendSystemPromptFile: long('system'),
    });
    const claude = long('claude.exe');
    const line = [claude, ...args].map(windowsArgument).join(' ');
    assert.ok(line.length <= 1_500, `the command line is ${line.length} characters`);
    const helper = jobObjectCommand(spawnCommand(claude, args, 'win32', {}), long('worktree'));
    const full = [helper.file, ...helper.args].map(windowsArgument).join(' ');
    assert.ok(full.length < 32_767, `the helper's command line is ${full.length} characters`);
  });
});

describe('resumeArgs', () => {
  const call = {
    model: 'claude-sonnet-5-5',
    effort: 'high' as const,
    settingsFile: '/work/attempt-settings/12-1/plan/1.json',
    tools: ['Read'],
    sessionId: '0f8fad5b-d9cb-469f-a165-70867728950e',
  };

  it('refuses a model, tools or session id that is not valid, as claudeArgs does (ADR 0126)', () => {
    assert.throws(() => resumeArgs({ ...call, model: '--model' }), /claude model is not valid/);
    assert.throws(() => resumeArgs({ ...call, tools: [] }), /claude tools is not valid/);
    assert.throws(
      () => resumeArgs({ ...call, sessionId: '--dangerous' }),
      /claude session id is not valid/,
    );
  });

  // ADR 0183: the CLI reference says the system prompt flags work in an interactive session too.
  it("passes the attempt's system prompt file last, when it has one", () => {
    const file = '/work/attempt-settings/12-1/plan/1.system.md';
    const args = resumeArgs({ ...call, appendSystemPromptFile: file });
    assert.deepEqual(args.slice(-2), ['--append-system-prompt-file', file]);
    assert.deepEqual(args.slice(0, -2), resumeArgs(call));
    assert.ok(!resumeArgs(call).includes('--append-system-prompt-file'));
  });
});

describe('interactiveArgs (ADR 0222)', () => {
  const folder = win32.join('D:', 'work', 'attempt-settings', '12-1', 'lauter');
  const call = {
    model: 'claude-sonnet-5-5',
    effort: 'high' as const,
    settingsFile: win32.join(folder, '1.json'),
    tools: ['Read', 'Edit'],
    sessionId: '0f8fad5b-d9cb-469f-a165-70867728950e',
    appendSystemPromptFile: win32.join(folder, '1.system.md'),
    firstMessage: `Read ${win32.join(folder, '1.prompt.md')}: it is your task in this session.`,
  };

  it("opens a new session with the recorded id, the first message and resume's guards, without print mode", () => {
    const args = interactiveArgs(call);
    const resumed = resumeArgs(call);
    assert.deepEqual(args, [
      call.firstMessage,
      '--session-id',
      call.sessionId,
      ...resumed.slice(resumed.indexOf('--model')),
    ]);
    for (const flag of ['--print', '--permission-mode', 'dontAsk', '--resume']) {
      assert.ok(!args.includes(flag), flag);
    }
  });

  it("passes as npm's claude.cmd line on Windows (ADR 0031)", () => {
    const claude = win32.join('C:', 'npm', 'claude.cmd');
    assert.doesNotThrow(() => windowsCommandLine(claude, interactiveArgs(call)));
  });

  it('refuses a first message of two lines, or one that reads as an option', () => {
    const twoLines = ['Read it.', 'Then more.'].join(String.fromCodePoint(10));
    for (const firstMessage of [twoLines, '--dangerously-skip-permissions', '']) {
      assert.throws(
        () => interactiveArgs({ ...call, firstMessage }),
        /claude first message is not valid/,
      );
    }
  });
});
