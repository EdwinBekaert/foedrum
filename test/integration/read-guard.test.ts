// The read guard with real processes and a real file system (ADR 0048): the hook command from the
// read-only agents' frontmatter run through bash the way Claude Code runs it, a real junction or
// link, Windows short names, and the installed `claude` with a hook in the runner's settings
// file. The guard's decisions are unit tests in test/unit/read-guard.test.ts.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, beforeEach, describe, it } from 'node:test';
import { claudeArgs } from '../../src/brewers/claude-command.ts';
import { resolveExecutable } from '../../src/platform/executables.ts';
import { streamProcess } from '../../src/platform/processes.ts';
import { realPath } from '../../src/platform/real-path.ts';
import { removeTree } from '../../src/platform/remove.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';
import { type FakeMessagesApi, startFakeMessagesApi } from './fake-messages-api.ts';

const root = join(import.meta.dirname, '..', '..');
const script = join(root, 'scripts', 'read-guard.ts');
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
const shortName = (path: string): string | undefined => {
  const result = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '$f = New-Object -ComObject Scripting.FileSystemObject; if (Test-Path -LiteralPath $env:P -PathType Container) { $f.GetFolder($env:P).ShortPath } else { $f.GetFile($env:P).ShortPath }',
    ],
    { encoding: 'utf8', env: { ...process.env, P: path }, timeout: 30_000 },
  );
  const short = result.stdout.trim();
  return result.status === 0 && short.includes('~') ? short : undefined;
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
    const short = shortName(programFiles);
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
    const short = shortName(long);
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

const claude = resolveExecutable('claude');

interface StreamEvent {
  type: string;
  message?: { content?: { type: string; content?: unknown; is_error?: boolean }[] };
}

interface Run {
  /** The one tool call of the fake model; by default, a Read of the file next to the worktree. */
  call?: { name: string; input: Record<string, unknown> };
  allow?: string[];
  hooks?: object;
  safeMode?: boolean;
}

// The brewer runner's command line (ADR 0046) with the attempt's `--settings` file. `--safe-mode`
// turns that file's hooks off too, so brewers get the rule from scoped allow rules instead, and
// the hook is tested without it (ADR 0048). The fake model reads next to the worktree.
describe('claude and reads outside its worktree', { skip: claude === undefined }, () => {
  let dir: TempDir;
  let api: FakeMessagesApi | undefined;
  let secret: string;
  beforeEach(() => {
    dir = makeTempDir('claude-read-guard');
    mkdirSync(join(dir.path, 'worktree'));
    mkdirSync(join(dir.path, 'user'));
    secret = join(dir.path, 'secret.txt');
    writeFileSync(secret, 'the-secret-text');
    writeFileSync(join(dir.path, 'worktree', 'inside.txt'), 'the-inside-text');
  });
  afterEach(async () => {
    await api?.close();
    api = undefined;
    removeTree(dir.path);
  });

  /** The results of the brewer's tool calls. */
  const toolResults = async ({
    call = { name: 'Read', input: { file_path: secret } },
    allow = ['Read'],
    hooks,
    safeMode = true,
  }: Run = {}) => {
    await api?.close();
    api = await startFakeMessagesApi(call);
    const settingsFile = join(dir.path, 'attempt-settings.json');
    writeFileSync(
      settingsFile,
      JSON.stringify({ permissions: { allow, deny: [] }, ...(hooks ? { hooks } : {}) }),
    );
    const all = claudeArgs({
      model: 'claude-haiku-5-5',
      effort: 'low',
      maxTurns: 3,
      settingsFile,
      tools: ['Read', 'Grep', 'Glob'],
      session: { kind: 'new', id: randomUUID() },
    });
    const args = safeMode ? all : all.filter((arg) => arg !== '--safe-mode');
    const inherited = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !/^(?:ANTHROPIC_|CLAUDE)/i.test(name)),
    );
    const lines: string[] = [];
    const result = await streamProcess(claude ?? 'claude', args, {
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
    return lines
      .map((line) => JSON.parse(line) as StreamEvent)
      .filter((e) => e.type === 'user')
      .flatMap((e) => e.message?.content ?? [])
      .filter((block) => block.type === 'tool_result')
      .map((block) => ({
        isError: block.is_error === true,
        content: JSON.stringify(block.content),
      }));
  };

  /** The one tool result, which must be an error that does not show the file. */
  const denied = async (run: Run, why: RegExp) => {
    const results = await toolResults(run);
    assert.equal(results.length, 1);
    assert.equal(results[0]?.isError, true, results[0]?.content);
    assert.match(results[0]?.content ?? '', why);
    assert.doesNotMatch(results[0]?.content ?? '', /the-secret-text/);
  };

  /** The one tool result, which must not be an error, and what it showed. */
  const allowed = async (run: Run): Promise<string> => {
    const results = await toolResults(run);
    assert.equal(results.length, 1);
    assert.equal(results[0]?.isError, false, results[0]?.content);
    return results[0]?.content ?? '';
  };

  const guardHooks = {
    PreToolUse: [
      {
        matcher: 'Read|Grep|Glob',
        hooks: [
          {
            type: 'command',
            command: `node ${JSON.stringify(script.replace(/\\/g, '/'))}`,
            timeout: 30,
          },
        ],
      },
    ],
  };

  const DONT_ASK = /don't ask mode/;

  // Without this the test would prove nothing: the fake model's read gets the file.
  it('reads a file outside the worktree when no hook is set', async () => {
    assert.match(await allowed({}), /the-secret-text/);
  });

  it('blocks that read when the settings file has the read guard, without --safe-mode', async () => {
    await denied({ hooks: guardHooks, safeMode: false }, /outside the checkout/);
  });

  // Why brewers cannot use the hook: their command line has --safe-mode (ADR 0046).
  it('does not run the hooks of the settings file under --safe-mode', async () => {
    assert.match(await allowed({ hooks: guardHooks }), /the-secret-text/);
  });

  describe('a Read rule scoped to the worktree, under --safe-mode', () => {
    const allow = ['Read(./**)'];

    it('allows a read inside the worktree', async () => {
      const call = { name: 'Read', input: { file_path: join(dir.path, 'worktree', 'inside.txt') } };
      assert.match(await allowed({ call, allow }), /the-inside-text/);
    });

    it('denies a read outside, with .. and through a junction or link', async () => {
      await denied({ allow }, DONT_ASK);
      await denied(
        { allow, call: { name: 'Read', input: { file_path: '../secret.txt' } } },
        DONT_ASK,
      );
      const link = join(dir.path, 'worktree', 'up');
      symlinkSync(dir.path, link, windows ? 'junction' : 'dir');
      const call = { name: 'Read', input: { file_path: join(link, 'secret.txt') } };
      await denied({ allow, call }, DONT_ASK);
    });

    it('scopes Grep and Glob too: inside allowed, outside denied', async () => {
      await allowed({ allow, call: { name: 'Grep', input: { pattern: 'inside' } } });
      await allowed({ allow, call: { name: 'Glob', input: { pattern: '*.txt' } } });
      await denied(
        { allow, call: { name: 'Grep', input: { pattern: 'secret', path: dir.path } } },
        DONT_ASK,
      );
      await denied(
        { allow, call: { name: 'Glob', input: { pattern: '*.txt', path: dir.path } } },
        DONT_ASK,
      );
      const absolute = `${dir.path.replace(/\\/g, '/')}/*.txt`;
      await denied({ allow, call: { name: 'Glob', input: { pattern: absolute } } }, DONT_ASK);
    });

    // So a brewer's bare Grep or Glob rule must not reach the settings file (ADR 0048).
    it('is undone by a bare Grep rule', async () => {
      const call = { name: 'Grep', input: { pattern: 'the-secret', path: dir.path } };
      assert.match(await allowed({ allow: [...allow, 'Grep'], call }), /secret\.txt/);
    });
  });

  // The read guard checks the folder a search starts in, not the links inside it: a pull request
  // can commit a link that leads outside (ADR 0048). Grep and Glob do not follow one.
  describe('a search of the worktree with a link in it that leads outside', () => {
    const allow = ['Read', 'Grep', 'Glob'];
    beforeEach(() => {
      symlinkSync(dir.path, join(dir.path, 'worktree', 'up'), windows ? 'junction' : 'dir');
    });

    it('does not find text behind the link with Grep', async () => {
      const call = { name: 'Grep', input: { pattern: 'the-secret', output_mode: 'content' } };
      assert.doesNotMatch(await allowed({ allow, call }), /the-secret-text|secret\.txt/);
    });

    it('does not list files behind the link with Glob', async () => {
      const listed = await allowed({
        allow,
        call: { name: 'Glob', input: { pattern: '**/*.txt' } },
      });
      assert.match(listed, /inside\.txt/);
      assert.doesNotMatch(listed, /secret\.txt/);
    });
  });
});
