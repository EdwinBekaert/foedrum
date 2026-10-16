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
}

const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as {
  cases: Case[];
};

const events = (file: string): StreamEvent[] =>
  readFileSync(join(dir, file), 'utf8')
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
      const stream = events(file);

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
        const text = readFileSync(join(dir, file), 'utf8');
        const paths = text.match(/[A-Za-z]:\\\\[^"]*/g) ?? [];
        for (const path of paths) {
          assert.match(path, /^C:\\\\(work\\\\brewery\\\\worktree|Windows\\\\System32\\\\)/);
        }
        assert.doesNotMatch(text, /\/(Users|home)\//);
      });
    });
  }
});
