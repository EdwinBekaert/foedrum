// The captured claude streams of #17 (ADR 0042): they hold what the brewer runner's parser will
// rely on, so a recapture that breaks one of these facts is a change of the CLI to look at first.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const dir = join(import.meta.dirname, '..', 'fixtures', 'claude-stream');

interface Case {
  file: string;
  exitCode: number;
}

interface StreamEvent {
  type: string;
  subtype?: string;
  session_id?: string;
  is_error?: boolean;
  parent_tool_use_id?: string | null;
  tool_use_id?: string;
  message?: { content: { type: string }[] };
  num_turns?: number;
  terminal_reason?: string;
  permission_denials?: { tool_use_id: string }[];
}

const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as {
  cases: Case[];
};

const events = (text: string): StreamEvent[] =>
  text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as StreamEvent);

describe('claude stream fixtures', () => {
  it('lists every captured stream in the manifest, and only those', () => {
    const files = readdirSync(dir).filter((name) => name.endsWith('.jsonl'));
    assert.deepEqual(manifest.cases.map((c) => c.file).sort(), files.sort());
  });

  for (const { file, exitCode } of manifest.cases) {
    describe(file, () => {
      const text = readFileSync(join(dir, file), 'utf8');
      const stream = events(text);

      it('is one JSON object with a type per line', () => {
        for (const event of stream) assert.equal(typeof event.type, 'string');
      });

      it('ends with its only result, which is an error exactly when the exit code is not 0', () => {
        const results = stream.filter((event) => event.type === 'result');
        assert.equal(results.length, 1);
        assert.equal(stream.at(-1), results[0]);
        assert.equal(results[0]?.is_error, exitCode !== 0);
      });

      it('starts with init when it has one, and every event names the same session', () => {
        const init = stream.findIndex((e) => e.type === 'system' && e.subtype === 'init');
        assert.ok(init <= 0, 'init is the first event');
        const sessions = new Set(stream.map((event) => event.session_id));
        assert.equal(sessions.size, 1);
        assert.equal(typeof [...sessions][0], 'string');
      });

      it('holds no path of the machine it was captured on', () => {
        // A drive letter after anything but a letter (not the `s:` of `https:`), with either slash.
        const paths = text.match(/(?<![A-Za-z])[A-Za-z]:(\\\\|\/)[^"]*/g) ?? [];
        for (const path of paths) {
          assert.match(path, /^C:(\\\\|\/)(work\1brewery\1worktree|Windows\1System32\1)/);
        }
        assert.doesNotMatch(text, /\/(Users|home)\//);
      });

      it('counts one turn more than its tool results when it started, none when it did not', () => {
        const toolResults = stream
          .filter((e) => e.type === 'user' && e.parent_tool_use_id === null)
          .flatMap((e) => e.message?.content ?? [])
          .filter((block) => block.type === 'tool_result').length;
        const started = stream[0]?.subtype === 'init';
        assert.equal(stream.at(-1)?.num_turns, started ? toolResults + 1 : 0);
      });
    });
  }

  const result = (file: string): StreamEvent | undefined =>
    events(readFileSync(join(dir, file), 'utf8')).at(-1);

  it('resumes the session it names, keeping its id', () => {
    assert.equal(result('resumed.jsonl')?.session_id, result('success.jsonl')?.session_id);
  });

  it('reports every live permission denial again in the result', () => {
    const stream = events(readFileSync(join(dir, 'permission-denials.jsonl'), 'utf8'));
    const live = stream
      .filter((e) => e.type === 'system' && e.subtype === 'permission_denied')
      .map((e) => e.tool_use_id);
    assert.equal(live.length, 2);
    assert.deepEqual(
      stream.at(-1)?.permission_denials?.map((d) => d.tool_use_id),
      live,
    );
  });

  it('ends a run at --max-turns as error_max_turns', () => {
    const end = result('max-turns.jsonl');
    assert.equal(end?.subtype, 'error_max_turns');
    assert.equal(end?.terminal_reason, 'max_turns');
  });

  it('reports an API error as subtype success with is_error', () => {
    const end = result('model-not-found.jsonl');
    assert.equal(end?.subtype, 'success');
    assert.equal(end?.is_error, true);
    assert.equal(end?.terminal_reason, 'api_error');
  });
});
