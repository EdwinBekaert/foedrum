import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { type AskedSession, checkInit } from '../../src/brewers/claude-init.ts';

const dir = join(import.meta.dirname, '..', 'fixtures', 'claude-stream');

/** The first event of a captured stream, parsed. */
const firstEvent = (file: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(dir, file), 'utf8').split('\n')[0] ?? '') as Record<string, unknown>;

const init = firstEvent('permission-denials.jsonl');
const asked: AskedSession = {
  sessionId: '00000000-0000-4000-8000-000000000032',
  tools: ['Read', 'Write', 'Bash'],
};

const mismatch = (event: unknown, of: AskedSession = asked): string => {
  const check = checkInit(event, of);
  assert.equal(check.kind, 'mismatch');
  return check.kind === 'mismatch' ? check.reason : '';
};

describe('checkInit', () => {
  it('records the session, the full model id and the CLI version of a session that matches', () => {
    assert.deepEqual(checkInit(init, asked), {
      kind: 'matches',
      session: {
        sessionId: '00000000-0000-4000-8000-000000000032',
        model: 'claude-haiku-5-5',
        claudeVersion: '2.1.301',
      },
    });
  });

  it('matches the captured inits of ADR 0042 with the tools each case asked for', () => {
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as {
      cases: { file: string; args: string[]; init: boolean }[];
    };
    const cases = manifest.cases.filter((c) => c.init && c.file !== 'tool-removed-by-deny.jsonl');
    assert.ok(cases.length >= 5);
    for (const { file, args } of cases) {
      const event = firstEvent(file);
      const tools = args[args.indexOf('--tools') + 1]?.split(',') ?? [];
      const check = checkInit(event, { sessionId: String(event.session_id), tools });
      assert.equal(check.kind, 'matches', file);
    }
  });

  it('takes the tools in any order', () => {
    assert.equal(checkInit(init, { ...asked, tools: ['Bash', 'Write', 'Read'] }).kind, 'matches');
  });

  // The settings were dropped, or a user's settings changed the mode (ADR 0045).
  it('refuses a permission mode other than dontAsk', () => {
    assert.match(mismatch({ ...init, permissionMode: 'default' }), /permission mode "default"/);
  });

  it('refuses a tool that was not asked for, and names it', () => {
    const reason = mismatch({ ...init, tools: ['Bash', 'Read', 'Write', 'WebFetch'] });
    assert.match(reason, /WebFetch/);
  });

  // A bare deny rule (the brewer's, a user's) removed it: the brewer would fail at it later.
  it('refuses a session without a tool that was asked for, and names it', () => {
    const removed = firstEvent('tool-removed-by-deny.jsonl');
    const reason = mismatch(removed, {
      sessionId: String(removed.session_id),
      tools: ['Read', 'Bash'],
    });
    assert.match(reason, /Bash/);
  });

  it('refuses an MCP server and its tools', () => {
    const server = { name: 'github', status: 'connected' };
    assert.match(mismatch({ ...init, mcp_servers: [server] }), /github/);
    assert.match(
      mismatch({ ...init, tools: [...asked.tools, 'mcp__github__create_issue'] }),
      /mcp__github__create_issue/,
    );
  });

  it('refuses skills and slash commands', () => {
    assert.match(mismatch({ ...init, skills: ['deploy'] }), /skills/);
    assert.match(mismatch({ ...init, slash_commands: ['deploy'] }), /slash commands/);
  });

  it('refuses another session id than the one the runner chose', () => {
    const reason = mismatch(init, { ...asked, sessionId: '6f1c2b9e-4d3a-4e8f-9a7b-1c2d3e4f5a6b' });
    assert.match(reason, /session/);
  });

  // Fail closed: what cannot be read cannot be shown to match.
  it('refuses an event that is not an init, or lacks a field it checks', () => {
    for (const event of [
      null,
      'init',
      { ...init, subtype: 'api_retry' },
      { type: 'result', subtype: 'error_during_execution' },
      Object.fromEntries(Object.entries(init).filter(([key]) => key !== 'tools')),
      { ...init, permissionMode: 7 },
    ]) {
      assert.match(mismatch(event), /init/, JSON.stringify(event)?.slice(0, 60));
    }
  });
});
