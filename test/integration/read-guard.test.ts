// The read guard with real processes and a real file system (ADR 0049): the hook command from the
// read-only agents' frontmatter run through bash the way Claude Code runs it, a real junction or
// link, Windows short names, and the installed `claude` with the guard as a hook in the runner's
// settings file (opt-in, FOEDRUM_REAL_CLAUDE=1). That one test runs our script inside claude; the
// tests of how claude itself treats hooks, scoped rules and links were dropped (ADR 0057). The
// guard's decisions are unit tests in test/unit/read-guard.test.ts.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, beforeEach, describe, it } from 'node:test';
import { claudeArgs } from '../../src/brewers/claude-command.ts';
import { streamProcess } from '../../src/platform/processes.ts';
import { realPath } from '../../src/platform/real-path.ts';
import { removeTree } from '../../src/platform/remove.ts';
import { realClaude } from '../helpers/real-claude.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';
import { type FakeMessagesApi, startFakeMessagesApi } from './fake-messages-api.ts';

const root = join(import.meta.dirname, '..', '..');
const windows = process.platform === 'win32';

interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

// Through the process runner, which kills the whole tree at its deadline.
const run = async (
  file: string,
  args: string[],
  stdin: string,
  { cwd, env }: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<ProcessResult> => {
  const lines: string[] = [];
  const result = await streamProcess(file, args, {
    cwd,
    env,
    stdin,
    timeoutMs: 60_000,
    jobObject: true,
    maxLineBytes: 1024 * 1024,
    onLine: (line) => lines.push(line),
  });
  assert.equal(result.killed, undefined, `${file} was killed: ${result.killed}`);
  return { code: result.exitCode, stdout: lines.join('\n'), stderr: result.stderr };
};

const hookInput = (tool: string, toolInput: Record<string, unknown>, cwd = root): string =>
  JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: toolInput, cwd });

// The command of taster's read guard, as its frontmatter has it (a single-quoted YAML string).
const agentHookCommand = (): string => {
  const text = readFileSync(join(root, '.claude', 'agents', 'taster.md'), 'utf8');
  const quoted = /^ {10}command: '(.*)'$/m.exec(text.replace(/\r\n/g, '\n'))?.[1];
  assert.ok(quoted !== undefined, 'no read guard command in taster.md');
  return quoted.replace(/''/g, "'");
};

/** The short (8.3) name of an existing path on Windows, or undefined when it has none. */
const shortName = async (path: string): Promise<string | undefined> => {
  const { code, stdout } = await run(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '$f = New-Object -ComObject Scripting.FileSystemObject; if (Test-Path -LiteralPath $env:P -PathType Container) { $f.GetFolder($env:P).ShortPath } else { $f.GetFile($env:P).ShortPath }',
    ],
    '',
    { cwd: root, env: { ...process.env, P: path } },
  );
  const short = stdout.trim();
  return code === 0 && short.includes('~') ? short : undefined;
};

describe('the read guard hook command', () => {
  // Read in each test, so a missing hook fails that test with an assertion.
  const runHook = (stdin: string, projectDir = root) =>
    run('bash', ['-c', agentHookCommand()], stdin, {
      cwd: root,
      env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
    });

  const dirs: TempDir[] = [];
  after(() => {
    for (const dir of dirs) removeTree(dir.path);
  });

  it('lets a read inside the checkout through silently', async () => {
    const result = await runHook(hookInput('Read', { file_path: join(root, 'package.json') }));
    assert.deepEqual(result, { code: 0, stdout: '', stderr: '' });
  });

  it('blocks a read outside the checkout with one line', async () => {
    const outside = join(homedir(), '.config', 'gh', 'hosts.yml');
    const { code, stderr } = await runHook(hookInput('Read', { file_path: outside }));
    assert.equal(code, 2);
    assert.match(stderr, /^Read is blocked: .* is outside the checkout/);
    assert.equal(stderr.split('\n').length, 2, stderr);
  });

  it('blocks .. that leaves the checkout', async () => {
    const { code, stderr } = await runHook(
      hookInput('Read', { file_path: join('..', '..', '..', 'outside.txt') }, join(root, 'src')),
    );
    assert.equal(code, 2, stderr);
    assert.match(stderr, /outside the checkout/);
  });

  it('blocks Grep and Glob outside the checkout', async () => {
    const grep = await runHook(hookInput('Grep', { pattern: 'token' }, homedir()));
    assert.equal(grep.code, 2, grep.stderr);
    assert.match(grep.stderr, /^Grep is blocked: .* outside the checkout/);
    const glob = await runHook(hookInput('Glob', { pattern: join(homedir(), '*') }));
    assert.equal(glob.code, 2, glob.stderr);
    assert.match(glob.stderr, /^Glob is blocked: .* outside the checkout/);
  });

  it('fails closed: blocks with exit 2 when the project has no scripts/read-guard.ts', async () => {
    const dir = makeTempDir('read-guard-missing');
    dirs.push(dir);
    const { code, stderr } = await runHook(
      hookInput('Read', { file_path: join(dir.path, 'a.txt') }),
      dir.path,
    );
    assert.equal(code, 2);
    assert.ok(stderr.includes('Foedrum read guard could not run (exit 1)'), `stderr: ${stderr}`);
  });

  // A junction on Windows (no privilege needed), a directory link elsewhere, inside the checkout,
  // to the home folder: the link is inside, what it leads to is not.
  it('blocks a read through a junction or link that leads outside', async () => {
    const dir = makeTempDir('read-guard-link');
    dirs.push(dir);
    const link = join(dir.path, 'home');
    symlinkSync(homedir(), link, windows ? 'junction' : 'dir');
    const { code, stderr } = await runHook(
      hookInput('Read', { file_path: join(link, '.config', 'gh', 'hosts.yml') }),
    );
    assert.equal(code, 2, stderr);
    assert.match(stderr, /resolves to/);
  });

  it('blocks a short name that leads outside', { skip: !windows }, async (t) => {
    const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
    const short = await shortName(programFiles);
    if (short === undefined) return t.skip('no short name for Program Files on this machine');
    assert.equal(realPath(short), realpathSync.native(programFiles));
    const { code, stderr } = await runHook(hookInput('Read', { file_path: join(short, 'x.txt') }));
    assert.equal(code, 2, stderr);
    assert.match(stderr, /outside the checkout/);
  });

  it('allows a short name of a folder inside the checkout', { skip: !windows }, async (t) => {
    const dir = makeTempDir('read-guard-short');
    dirs.push(dir);
    const long = join(dir.path, 'a folder with a long name');
    mkdirSync(long);
    writeFileSync(join(long, 'a.txt'), 'a');
    const short = await shortName(long);
    if (short === undefined) return t.skip('short names are off on the checkout drive');
    const result = await runHook(hookInput('Read', { file_path: join(short, 'a.txt') }));
    assert.deepEqual(result, { code: 0, stdout: '', stderr: '' });
  });

  it('allows a path inside in another case on Windows', { skip: !windows }, async () => {
    const result = await runHook(
      hookInput('Read', { file_path: join(root, 'package.json').toUpperCase() }),
    );
    assert.deepEqual(result, { code: 0, stdout: '', stderr: '' });
  });
});

const real = realClaude();
const script = join(root, 'scripts', 'read-guard.ts');

interface StreamEvent {
  type: string;
  message?: { content?: { type: string; content?: unknown; is_error?: boolean }[] };
}

// Our read guard as a hook in the settings file of the runner's command line (ADR 0046), inside
// the installed `claude` (ADR 0057: opt-in). `--safe-mode` turns hooks off, so it is left out:
// brewers get the rule from scoped allow rules instead (ADR 0049). The fake model reads a file
// next to the worktree.
describe('claude with the read guard as a hook', {
  skip: real.kind === 'skip' && real.reason,
}, () => {
  let dir: TempDir;
  let api: FakeMessagesApi | undefined;
  beforeEach(() => {
    dir = makeTempDir('claude-read-guard');
    mkdirSync(join(dir.path, 'worktree'));
    mkdirSync(join(dir.path, 'user'));
  });
  afterEach(async () => {
    await api?.close();
    api = undefined;
    removeTree(dir.path);
  });

  it('blocks a read outside the worktree when the settings file has the read guard, without --safe-mode', async () => {
    const secret = join(dir.path, 'secret.txt');
    writeFileSync(secret, 'the-secret-text');
    api = await startFakeMessagesApi({ name: 'Read', input: { file_path: secret } });
    const settingsFile = join(dir.path, 'attempt-settings.json');
    const hook = {
      type: 'command',
      command: `node ${JSON.stringify(script.replace(/\\/g, '/'))}`,
      timeout: 30,
    };
    writeFileSync(
      settingsFile,
      JSON.stringify({
        permissions: { allow: ['Read'], deny: [] },
        hooks: { PreToolUse: [{ matcher: 'Read|Grep|Glob', hooks: [hook] }] },
      }),
    );
    const args = claudeArgs({
      model: 'claude-haiku-5-5',
      effort: 'low',
      maxTurns: 3,
      settingsFile,
      tools: ['Read', 'Grep', 'Glob'],
      session: { kind: 'new', id: randomUUID() },
    }).filter((arg) => arg !== '--safe-mode');
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
      },
      stdin: 'Read the file.',
      maxLineBytes: 1024 * 1024,
      timeoutMs: 120_000,
      jobObject: true,
      onLine: (line) => lines.push(line),
    });
    assert.equal(result.exitCode, 0, result.stderr);
    const results = lines
      .map((line) => JSON.parse(line) as StreamEvent)
      .filter((e) => e.type === 'user')
      .flatMap((e) => e.message?.content ?? [])
      .filter((block) => block.type === 'tool_result');
    assert.equal(results.length, 1);
    const content = JSON.stringify(results[0]?.content);
    assert.equal(results[0]?.is_error, true, content);
    assert.match(content, /outside the checkout/);
    assert.doesNotMatch(content, /the-secret-text/);
  });
});
