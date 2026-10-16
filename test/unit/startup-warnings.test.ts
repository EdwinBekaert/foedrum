// Permission rules that make Claude Code warn at startup fail npm run check (#42). The patterns
// come from the Claude Code docs linked in scripts/startup-warnings.ts; update both when the
// docs change.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { type Permissions, startupWarnings } from '../../scripts/startup-warnings.ts';

const root = join(import.meta.dirname, '..', '..');

describe('startupWarnings', () => {
  const warned: [name: string, permissions: Permissions][] = [
    // Path rules on file tools other than Edit and Read are never consulted.
    ['a Write path rule', { deny: ['Write(/x)'] }],
    ['a NotebookEdit path rule', { allow: ['NotebookEdit(docs/**)'] }],
    ['a Glob path rule', { ask: ['Glob(./secrets/**)'] }],
    ['a MultiEdit path rule', { deny: ['MultiEdit(src/**)'] }],
    // A tool's main field can't be matched as a parameter.
    ['a rule on Bash command', { deny: ['Bash(command:rm *)'] }],
    ['a rule on PowerShell command', { ask: ['PowerShell(command: git push *)'] }],
    ['a rule on Read file_path', { deny: ['Read(file_path:/etc/passwd)'] }],
    ['a rule on Edit file_path', { deny: ['Edit(file_path:*)'] }],
    ['a rule on Write file_path', { deny: ['Write(file_path:*)'] }],
    ['a rule on Grep path', { deny: ['Grep(path:/x)'] }],
    ['a rule on Glob path', { deny: ['Glob(path:/x)'] }],
    ['a rule on NotebookEdit notebook_path', { deny: ['NotebookEdit(notebook_path:x)'] }],
    ['a rule on WebFetch url', { deny: ['WebFetch(url:https://example.com)'] }],
    // Typos in deny and ask.
    ['an unknown tool in deny', { deny: ['Bsh(git push *)'] }],
    ['an unknown bare tool in ask', { ask: ['Stop Task'] }],
    // Allow globs not anchored to one MCP server.
    ['a wildcard-only allow rule', { allow: ['*'] }],
    ['a partial tool-name glob in allow', { allow: ['B*'] }],
    ['an MCP-wide allow glob', { allow: ['mcp__*'] }],
    ['an allow glob on the server segment', { allow: ['mcp__git*__status'] }],
    // A * before the word that says which command it is.
    ['a * before the subcommand', { allow: ['Bash(git * main)'] }],
    ['a * between options and the subcommand', { allow: ['Bash(git -C * status *)'] }],
    ['a * before the subcommand in PowerShell', { allow: ['PowerShell(git * main)'] }],
  ];
  for (const [name, permissions] of warned) {
    it(`warns about ${name}`, () => {
      const warnings = startupWarnings(permissions);
      assert.equal(warnings.length, 1, warnings.join('\n'));
      const [rule] = [
        ...(permissions.allow ?? []),
        ...(permissions.ask ?? []),
        ...(permissions.deny ?? []),
      ];
      assert.ok(warnings[0]?.includes(rule ?? ''), warnings[0]);
    });
  }

  const quiet: [name: string, permissions: Permissions][] = [
    ['an Edit path rule', { deny: ['Edit(/.npmrc)'] }],
    ['a Read path rule', { deny: ['Read(./.env)'] }],
    ['a bare Write rule', { deny: ['Write'] }],
    ['a bare Glob rule', { allow: ['Glob'] }],
    ['a trailing wildcard', { allow: ['Bash(git log *)', 'PowerShell(npm run *)'] }],
    ['the :* suffix', { allow: ['Bash(ls:*)'] }],
    ['a * glued to the end of a word', { ask: ['Bash(gh api * -X*)'] }],
    [
      'a parameter rule on another field',
      { deny: ['Agent(isolation:worktree)', 'Bash(run_in_background:true)'] },
    ],
    ['a tool-name glob in deny', { deny: ['mcp__*', '*'] }],
    ['an anchored MCP allow glob', { allow: ['mcp__puppeteer__*', 'mcp__github__get_*'] }],
    ['an unknown tool with _ in deny', { deny: ['custom_tool'] }],
    ['a removed tool in deny', { deny: ['TaskOutput'] }],
    ['an unknown tool in allow', { allow: ['SomeFutureTool'] }],
    ['WebFetch by domain', { allow: ['WebFetch(domain:example.com)'] }],
  ];
  for (const [name, permissions] of quiet) {
    it(`does not warn about ${name}`, () => {
      assert.deepEqual(startupWarnings(permissions), []);
    });
  }
});

describe('.claude/settings.json', () => {
  it('has no permission rule that Claude Code warns about at startup', () => {
    const settings = JSON.parse(readFileSync(join(root, '.claude', 'settings.json'), 'utf8')) as {
      permissions?: Permissions;
    };
    assert.deepEqual(startupWarnings(settings.permissions ?? {}), []);
  });
});
