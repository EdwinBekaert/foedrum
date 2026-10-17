// The brewer runner's reading of claude's stream (#11, ADR 0042, ADR 0046, ADR 0047): each
// captured stream of #17 must come to the facts settleAttempt decides on.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { readClaudeStream, type StreamAsk } from '../../src/brewers/claude-stream.ts';
import { descheduled } from '../helpers/load.ts';

const dir = join(import.meta.dirname, '..', 'fixtures', 'claude-stream');
const lines = (file: string): string[] =>
  readFileSync(join(dir, file), 'utf8')
    .split('\n')
    .filter((line) => line !== '');

const at = (seconds: number): Date => new Date(Date.UTC(2026, 9, 16, 12, 0, seconds));
const started = at(0);

/** Reads every line, one second apart; the answers say where the reader asked to stop. */
const readAll = (all: readonly string[], asked: StreamAsk) => {
  const reader = readClaudeStream(asked, started);
  const answers = all.map((line, index) => reader.read(line, at(index + 1)));
  return { reader, answers, facts: reader.facts() };
};

const session = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// Synthetic events in the shape of the fixtures.
const init = (tools: string[] = ['Read', 'Write', 'Bash']): string =>
  JSON.stringify({
    type: 'system',
    subtype: 'init',
    session_id: session(1),
    tools,
    mcp_servers: [],
    model: 'claude-haiku-5-5',
    permissionMode: 'dontAsk',
    slash_commands: [],
    skills: [],
    claude_code_version: '2.1.301',
  });
const asked: StreamAsk = { sessionId: session(1), tools: ['Read', 'Write', 'Bash'] };
const assistant = (id: string, content: unknown[], more: Record<string, unknown> = {}): string =>
  JSON.stringify({
    type: 'assistant',
    message: { id, role: 'assistant', content },
    parent_tool_use_id: null,
    session_id: session(1),
    ...more,
  });
const toolUse = (id: string, name: string, input: Record<string, unknown>) => ({
  type: 'tool_use',
  id,
  name,
  input,
});
const toolResult = (id: string, isError = false): string =>
  JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content: 'ok', is_error: isError }],
    },
    parent_tool_use_id: null,
    session_id: session(1),
  });
const result = (more: Record<string, unknown> = {}): string =>
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    num_turns: 1,
    session_id: session(1),
    usage: {
      input_tokens: 3,
      output_tokens: 4,
      cache_read_input_tokens: 5,
      cache_creation_input_tokens: 6,
    },
    ...more,
  });
const rateLimit = JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'ok' } });
const thinking = JSON.stringify({ type: 'system', subtype: 'thinking_tokens', session_id: '' });
const uiInvalidate = JSON.stringify({ type: 'system', subtype: 'ui_invalidate' });

describe('readClaudeStream over the captured streams', () => {
  it('reads a successful attempt: its session, turns and usage, and nothing wrong', () => {
    const { facts, answers } = readAll(lines('success.jsonl'), {
      sessionId: session(1),
      tools: ['Read'],
    });
    assert.ok(answers.every((answer) => answer === 'go'));
    assert.deepEqual(facts, {
      session: { sessionId: session(1), model: 'claude-haiku-5-5', claudeVersion: '2.1.301' },
      denials: 0,
      deniedTools: [],
      turns: 1,
      usage: { inputTokens: 2, outputTokens: 4, cacheReadTokens: 1670, cacheWriteTokens: 2452 },
      lines: 4,
    });
  });

  it('reads a resumed session as the same session', () => {
    const { facts } = readAll(lines('resumed.jsonl'), { sessionId: session(1), tools: ['Read'] });
    assert.equal(facts.session?.sessionId, session(1));
    assert.equal(facts.environment, undefined);
    assert.equal(facts.streamError, undefined);
  });

  // A bare deny rule removed Bash: the session is not the one asked for (ADR 0046).
  it('stops at an init that is missing a tool, and reads nothing after it', () => {
    const { facts, answers } = readAll(lines('tool-removed-by-deny.jsonl'), {
      sessionId: session(14),
      tools: ['Read', 'Bash'],
    });
    assert.deepEqual(answers.slice(0, 2), ['stop', 'stop']);
    assert.equal(facts.environment, 'tools asked for but missing: "Bash"');
    assert.equal(facts.session, undefined);
    assert.equal(facts.turns, 0);
  });

  it('counts each permission denial and names each denied tool once', () => {
    const { facts, answers } = readAll(lines('permission-denials.jsonl'), {
      sessionId: session(32),
      tools: ['Bash', 'Read', 'Write'],
    });
    assert.ok(answers.every((answer) => answer === 'go'));
    assert.equal(facts.denials, 2);
    assert.deepEqual(facts.deniedTools, ['Write', 'Bash']);
    assert.equal(facts.turns, 4);
  });

  it('stops at the denial that reaches maxDenials', () => {
    const all = lines('permission-denials.jsonl');
    const { answers, facts } = readAll(all, {
      sessionId: session(32),
      tools: ['Bash', 'Read', 'Write'],
      maxDenials: 2,
    });
    const second = all.findLastIndex((line) => line.includes('"permission_denied"'));
    assert.equal(answers.indexOf('stop'), second);
    assert.equal(facts.denials, 2);
  });

  // ADR 0042: num_turns, not a count of assistant messages; is_error decides.
  it('reads the turns and the error of a run that reached its maximum turns', () => {
    const { facts } = readAll(lines('max-turns.jsonl'), {
      sessionId: session(59),
      tools: ['Read'],
    });
    assert.equal(facts.turns, 2);
    assert.equal(facts.streamError, 'max_turns: Reached maximum number of turns (1)');
    assert.equal(facts.environment, undefined);
  });

  // The consultant's item 4 (#11): an unknown model is the environment, not a crash to retry.
  it('makes an error before the first model reply an environment failure', () => {
    const { facts } = readAll(lines('model-not-found.jsonl'), {
      sessionId: session(68),
      tools: ['Read'],
    });
    assert.match(
      facts.environment ?? '',
      /^claude failed before the model replied: model_not_found: There's an issue with the selected model \(claude-nope-9-9\)/,
    );
  });

  it('makes a result before the session started an environment failure', () => {
    for (const [file, why] of [
      ['resume-not-found.jsonl', /No conversation found with session ID/],
      ['sandbox-unavailable.jsonl', /Sandbox required but unavailable/],
    ] as const) {
      const { facts } = readAll(lines(file), { sessionId: session(1), tools: ['Read'] });
      assert.match(facts.environment ?? '', /^claude ended before the session started: /, file);
      assert.match(facts.environment ?? '', why, file);
      assert.equal(facts.session, undefined, file);
    }
  });
});

describe('readClaudeStream', () => {
  // Seen with an API key or a new configuration folder (ADR 0046).
  it('skips system events before init', () => {
    const { facts, answers } = readAll([uiInvalidate, thinking, init(), result()], asked);
    assert.deepEqual(answers, ['go', 'go', 'go', 'go']);
    assert.equal(facts.environment, undefined);
    assert.equal(facts.session?.sessionId, session(1));
  });

  it('stops at any other event before init: the session cannot be shown to match', () => {
    const { facts, answers } = readAll(
      [assistant('msg_1', [{ type: 'text', text: 'hi' }]), init()],
      asked,
    );
    assert.deepEqual(answers, ['stop', 'stop']);
    assert.match(facts.environment ?? '', /does not start with an init event/);
  });

  it('keeps the first line that is not a stream-json event, and skips empty lines', () => {
    const { facts, answers } = readAll(
      [init(), '', 'Abort trap', '[1, 2]', '{"no":"type"}', result()],
      asked,
    );
    assert.ok(answers.every((answer) => answer === 'go'));
    assert.equal(facts.garbage, 'Abort trap');
    assert.equal(facts.lines, 6);
  });

  it('records an error claude reported after the model replied as a stream error', () => {
    const { facts } = readAll(
      [
        init(),
        assistant('msg_1', [{ type: 'text', text: 'working' }]),
        result({ is_error: true, terminal_reason: 'api_error', result: 'Overloaded' }),
      ],
      asked,
    );
    assert.equal(facts.environment, undefined);
    assert.equal(facts.streamError, 'api_error: Overloaded');
  });

  // An overloaded API may pass: only an error that names a cause the next attempt meets again
  // is the environment (review of #133).
  it('keeps an error result before the first model reply that names no lasting cause retryable', () => {
    const { facts } = readAll(
      [init(), result({ is_error: true, terminal_reason: 'api_error', result: 'Overloaded' })],
      asked,
    );
    assert.equal(facts.environment, undefined);
    assert.equal(facts.streamError, 'api_error: Overloaded');
  });

  // Review of #133: only a cause the next attempt meets again is the environment.
  it('makes an assistant error before the first reply the environment only for a lasting cause', () => {
    for (const [error, lasting] of [
      ['authentication_failed', true],
      ['billing_error', true],
      ['invalid_request', true],
      ['model_not_found', true],
      ['rate_limit', false],
      ['server_error', false],
      ['unknown', false],
    ] as const) {
      const { facts } = readAll(
        [
          init(),
          assistant('msg_1', [{ type: 'text', text: 'It failed.' }], { error }),
          result({ is_error: true, terminal_reason: 'api_error', result: 'It failed.' }),
        ],
        asked,
      );
      assert.equal(
        facts.environment,
        lasting ? `claude failed before the model replied: ${error}: It failed.` : undefined,
        error,
      );
      assert.equal(facts.streamError, 'api_error: It failed.', error);
    }
  });

  it('reads nothing more after the denial that reaches maxDenials', () => {
    const denial = (tool: string): string =>
      JSON.stringify({ type: 'system', subtype: 'permission_denied', tool_name: tool });
    const { facts, answers } = readAll(
      [init(), denial('Write'), denial('Bash'), denial('WebFetch'), result()],
      { ...asked, maxDenials: 2 },
    );
    assert.deepEqual(answers, ['go', 'go', 'stop', 'stop', 'stop']);
    assert.equal(facts.denials, 2);
    assert.deepEqual(facts.deniedTools, ['Write', 'Bash']);
  });

  it('records a result event it cannot read as a stream error', () => {
    const { facts } = readAll([init(), assistant('msg_1', []), result({ is_error: 'yes' })], asked);
    assert.equal(facts.streamError, 'the result event could not be read');
  });

  it('cuts a long error to 200 characters and an ellipsis', () => {
    const { facts } = readAll(
      [init(), assistant('msg_1', []), result({ is_error: true, errors: ['x'.repeat(5000)] })],
      asked,
    );
    const said = `success: ${'x'.repeat(5000)}`;
    assert.equal(facts.streamError, `${said.slice(0, 200)}…`);
  });

  it('cuts a long error short', () => {
    const { facts } = readAll(
      [init(), assistant('msg_1', []), result({ is_error: true, errors: ['x'.repeat(5000)] })],
      asked,
    );
    assert.ok((facts.streamError ?? '').length <= 220, `${facts.streamError?.length}`);
  });

  it('counts turns live by the main thread’s messages, one per message id', () => {
    const reader = readClaudeStream(asked, started);
    reader.read(init(), at(1));
    reader.read(assistant('msg_1', [{ type: 'thinking', thinking: '' }]), at(2));
    reader.read(assistant('msg_1', [toolUse('t1', 'Read', { file_path: 'a' })]), at(3));
    reader.read(
      assistant('msg_sub', [{ type: 'text', text: 'sub' }], { parent_tool_use_id: 't1' }),
      at(4),
    );
    reader.read(assistant('msg_2', [{ type: 'text', text: 'done' }]), at(5));
    assert.equal(reader.facts().turns, 2);
  });
});

// The stall watchdog's signal (ADR 0027, ADR 0047): a file written or a commit made, read from
// the tool calls and their results; no other event counts.
describe('readClaudeStream progress', () => {
  const run = (events: string[]) => {
    const reader = readClaudeStream(asked, started);
    events.forEach((line, index) => {
      reader.read(line, at(index + 1));
    });
    return reader.progress();
  };

  it('starts at the start of the attempt with no turns', () => {
    assert.deepEqual(readClaudeStream(asked, started).progress(), {
      lastProgressAt: started,
      turnsWithoutProgress: 0,
    });
  });

  it('counts turns without a file write: reads, failed writes, system and rate-limit events', () => {
    const progress = run([
      init(),
      assistant('msg_1', [toolUse('t1', 'Read', { file_path: 'a' })]),
      toolResult('t1'),
      assistant('msg_2', [toolUse('t2', 'Write', { file_path: 'b', content: '' })]),
      toolResult('t2', true),
      assistant('msg_3', [toolUse('t3', 'Bash', { command: 'git status' })]),
      toolResult('t3'),
      rateLimit,
      thinking,
    ]);
    assert.deepEqual(progress, { lastProgressAt: started, turnsWithoutProgress: 3 });
  });

  it('counts a written file as progress, when its result comes back without an error', () => {
    for (const name of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) {
      const progress = run([
        init(),
        assistant('msg_1', [toolUse('t1', 'Read', { file_path: 'a' })]),
        toolResult('t1'),
        assistant('msg_2', [toolUse('t2', name, { file_path: 'b' })]),
        toolResult('t2'),
        assistant('msg_3', [{ type: 'text', text: 'next' }]),
      ]);
      assert.deepEqual(progress, { lastProgressAt: at(5), turnsWithoutProgress: 1 }, name);
    }
  });

  it('counts a commit as progress, through either shell', () => {
    for (const [name, command] of [
      ['Bash', 'git commit -m "Add the parser"'],
      ['PowerShell', 'git add -A; git commit -m x'],
      ['Bash', 'git -C . commit --amend'],
    ] as const) {
      const progress = run([
        init(),
        assistant('msg_1', [toolUse('t1', name, { command })]),
        toolResult('t1'),
      ]);
      assert.deepEqual(progress, { lastProgressAt: at(3), turnsWithoutProgress: 0 }, command);
    }
  });

  // #134: `commit` counts only as git's subcommand, after git's own options.
  it('counts a commit after git global options, a path to git, or variables before it', () => {
    for (const command of [
      'git -c user.name=Brewer commit -m x',
      'git --no-pager -C /work/tree commit -m x',
      'git --git-dir=.git --work-tree=. commit -m x',
      '/usr/bin/git commit -m x',
      '"C:\\Program Files\\Git\\cmd\\git.exe" commit -m x',
      'GIT_AUTHOR_NAME=Brewer git commit -m x',
      '  git   commit',
    ]) {
      const progress = run([
        init(),
        assistant('msg_1', [toolUse('t1', 'Bash', { command })]),
        toolResult('t1'),
      ]);
      assert.deepEqual(progress, { lastProgressAt: at(3), turnsWithoutProgress: 0 }, command);
    }
  });

  it('skips the value of git options that take one as the next word', () => {
    for (const [command, counts] of [
      ['git --git-dir .git --work-tree . commit -m x', true],
      ['git --namespace commit status', false],
      ['git --config-env commit=X status', false],
      ['git -c commit=x status', false],
    ] as const) {
      const progress = run([
        init(),
        assistant('msg_1', [toolUse('t1', 'Bash', { command })]),
        toolResult('t1'),
      ]);
      assert.deepEqual(
        progress,
        counts
          ? { lastProgressAt: at(3), turnsWithoutProgress: 0 }
          : { lastProgressAt: started, turnsWithoutProgress: 1 },
        command,
      );
    }
  });

  // Review of #136: a separator inside quotes does not end the command.
  it('does not count a commit inside a quoted argument', () => {
    for (const command of ['echo "done; git commit -m x"', "printf 'a | git commit'"]) {
      const progress = run([
        init(),
        assistant('msg_1', [toolUse('t1', 'Bash', { command })]),
        toolResult('t1'),
      ]);
      assert.deepEqual(progress, { lastProgressAt: started, turnsWithoutProgress: 1 }, command);
    }
  });

  it('does not count commit as anything but the subcommand of git', () => {
    for (const command of [
      'git log --grep commit',
      'echo git commit',
      'git show HEAD:commit.txt',
      'git config commit.gpgsign false',
      'git -C commit status',
      'git help commit',
    ]) {
      const progress = run([
        init(),
        assistant('msg_1', [toolUse('t1', 'Bash', { command })]),
        toolResult('t1'),
      ]);
      assert.deepEqual(progress, { lastProgressAt: started, turnsWithoutProgress: 1 }, command);
    }
  });

  // The command is model output: a long one must not hold the engine (review of #133).
  it('reads a long shell command in linear time', () => {
    const command = 'git '.repeat(16_000);
    const t0 = performance.now();
    // A loaded machine takes the CPU away for a while (#147).
    descheduled(250);
    const progress = run([
      init(),
      assistant('msg_1', [toolUse('t1', 'Bash', { command })]),
      toolResult('t1'),
    ]);
    const elapsed = performance.now() - t0;
    assert.ok(elapsed < 200, `took ${Math.round(elapsed)} ms`);
    assert.deepEqual(progress, { lastProgressAt: started, turnsWithoutProgress: 1 });
  });

  it('does not count a command that only mentions a commit', () => {
    for (const command of [
      'git log --oneline | grep commit',
      'git status; echo commit',
      'git status && echo commit',
      'git status\necho commit',
      'echo commit git',
    ]) {
      const progress = run([
        init(),
        assistant('msg_1', [toolUse('t1', 'Bash', { command })]),
        toolResult('t1'),
      ]);
      assert.deepEqual(progress, { lastProgressAt: started, turnsWithoutProgress: 1 }, command);
    }
  });

  it('does not count a commit command that failed', () => {
    const progress = run([
      init(),
      assistant('msg_1', [toolUse('t1', 'Bash', { command: 'git commit -m x' })]),
      toolResult('t1', true),
    ]);
    assert.deepEqual(progress, { lastProgressAt: started, turnsWithoutProgress: 1 });
  });
});
