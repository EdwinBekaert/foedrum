// The deps:sync shell with fake files and a fake process runner (ADR 0021). The staleness
// decisions are in deps-sync-core.test.ts; the script itself runs in test/integration.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { outOfDate, type ReadText, syncDeps } from '../../scripts/deps-sync.ts';
import type { ProcessOutcome, RunOptions, RunProcess } from '../../scripts/process-runner.ts';

const root = join('/work', 'tree');
const execPath = '/usr/local/bin/node';
const npmCli = '/usr/local/lib/node_modules/npm/bin/npm-cli.js';

const zod = { version: '4.6.5', integrity: 'sha512-z' };
const lock = JSON.stringify({ packages: { '': {}, 'node_modules/zod': zod } });
const matching = JSON.stringify({ packages: { 'node_modules/zod': zod } });
const older = JSON.stringify({ packages: { 'node_modules/zod': { ...zod, version: '4.6.4' } } });
const REASON = 'node_modules/zod 4.6.4 is installed, package-lock.json has 4.6.5';

// A checkout at `root` with package.json, package-lock.json and the given installed record.
const checkout = (installed: string | undefined, files: Record<string, string> = {}) => {
  const contents = new Map<string, string>([
    [join(root, 'package.json'), '{}'],
    [join(root, 'package-lock.json'), lock],
    ...Object.entries(files),
  ]);
  if (installed !== undefined) {
    contents.set(join(root, 'node_modules', '.package-lock.json'), installed);
  }
  const read: ReadText = async (path) => contents.get(path);
  return read;
};

// A fake process runner that records each call and answers with the given outcome.
const fakeProcess = (outcome: ProcessOutcome = { exitCode: 0, output: 'added 4 packages\n' }) => {
  const calls: [file: string, args: string[], cwd: string][] = [];
  const runProcess: RunProcess = async (file, args, cwd) => {
    calls.push([file, args, cwd]);
    return outcome;
  };
  return { calls, runProcess };
};

describe('outOfDate', () => {
  it('is undefined when node_modules matches package-lock.json', async () => {
    assert.equal(await outOfDate(root, checkout(matching)), undefined);
  });

  it('names the package root and the reason when node_modules is stale', async () => {
    assert.deepEqual(await outOfDate(root, checkout(older)), { root, reason: REASON });
  });

  it('finds the package root from a subdirectory, as npm does', async () => {
    assert.deepEqual(await outOfDate(join(root, 'src', 'engine'), checkout(older)), {
      root,
      reason: REASON,
    });
  });

  it('stops at the nearest package.json, as npm does', async () => {
    const nested = join(root, 'test', 'fixtures', 'project');
    const read = checkout(older, { [join(nested, 'package.json')]: '{}' });
    assert.equal(await outOfDate(join(nested, 'src'), read), undefined);
  });

  it('is undefined outside a package', async () => {
    assert.equal(await outOfDate(root, async () => undefined), undefined);
  });

  it('is undefined without package-lock.json, as there is nothing to compare', async () => {
    const read: ReadText = async (path) => (path === join(root, 'package.json') ? '{}' : undefined);
    assert.equal(await outOfDate(root, read), undefined);
  });
});

describe('syncDeps', () => {
  const env = { npm_execpath: npmCli };

  it('does nothing and says nothing when node_modules is up to date', async () => {
    const { calls, runProcess } = fakeProcess();
    assert.deepEqual(await syncDeps(root, env, execPath, runProcess, checkout(matching)), []);
    assert.deepEqual(calls, []);
  });

  it('runs npm ci with this node and npm_execpath in the package root when stale', async () => {
    const { calls, runProcess } = fakeProcess();
    const lines = await syncDeps(join(root, 'src'), env, execPath, runProcess, checkout(older));
    assert.deepEqual(calls, [[execPath, [npmCli, 'ci'], root]]);
    assert.deepEqual(lines, [
      `node_modules was out of date with package-lock.json (${REASON}); ran npm ci`,
    ]);
  });

  it('runs npm ci when npm never recorded an install', async () => {
    const { calls, runProcess } = fakeProcess();
    await syncDeps(root, env, execPath, runProcess, checkout(undefined));
    assert.deepEqual(calls, [[execPath, [npmCli, 'ci'], root]]);
  });

  it('reports a failed npm ci with the end of its output', async () => {
    const output = `${'x'.repeat(5000)}\nnpm error code EBUSY\n`;
    const { runProcess } = fakeProcess({ exitCode: 1, output });
    const lines = await syncDeps(root, env, execPath, runProcess, checkout(older));
    assert.equal(lines.length, 1);
    assert.match(
      lines[0] ?? '',
      /^node_modules is out of date with package-lock.json \(.+\); npm ci failed \(exit 1\), run it yourself:\n/,
    );
    assert.match(lines[0] ?? '', /npm error code EBUSY$/);
    assert.ok((lines[0] ?? '').length < 2500, 'only the end of the output');
  });

  // Outside Windows npm ci leads a process group of its own, which the end of the SessionStart
  // hook does not reach: deps:sync passes its stop on and sets a deadline under the hook's (#12).
  it("gives npm ci deps:sync's stop signal and a deadline under the hook's 600 s", async () => {
    const options: (RunOptions | undefined)[] = [];
    const runProcess: RunProcess = async (_file, _args, _cwd, given) => {
      options.push(given);
      return { exitCode: 0, output: '' };
    };
    const stop = new AbortController();
    await syncDeps(root, env, execPath, runProcess, checkout(older), stop.signal);
    assert.equal(options.length, 1);
    assert.equal(options[0]?.signal, stop.signal);
    const timeoutMs = options[0]?.timeoutMs ?? 0;
    assert.ok(timeoutMs > 0 && timeoutMs < 600_000, String(timeoutMs));
  });

  for (const [killed, reason] of [
    ['timed-out', /npm ci failed \(timed out after \d+ s\), run it yourself:\npartial$/],
    ['stopped', /npm ci failed \(stopped\), run it yourself:\npartial$/],
  ] as const) {
    it(`reports an npm ci the runner killed (${killed}) with why`, async () => {
      const { runProcess } = fakeProcess({ exitCode: null, output: 'partial', killed });
      const [line] = await syncDeps(root, env, execPath, runProcess, checkout(older));
      assert.match(line ?? '', reason);
    });
  }

  it('reports an npm ci that could not start or was killed', async () => {
    const { runProcess } = fakeProcess({ exitCode: null, output: 'spawn ENOENT' });
    const [line] = await syncDeps(root, env, execPath, runProcess, checkout(older));
    assert.match(line ?? '', /npm ci failed \(no exit code\), run it yourself:\nspawn ENOENT$/);
  });

  for (const [name, npmEnv] of [
    ['missing', {}],
    ['empty', { npm_execpath: '' }],
  ] as const) {
    it(`starts no process when npm_execpath is ${name}`, async () => {
      const { calls, runProcess } = fakeProcess();
      const lines = await syncDeps(root, npmEnv, execPath, runProcess, checkout(older));
      assert.deepEqual(calls, []);
      assert.deepEqual(lines, [
        `node_modules is out of date with package-lock.json (${REASON}); npm_execpath is not set, so run npm ci yourself`,
      ]);
    });
  }
});

interface SessionStartGroup {
  matcher?: string;
  hooks?: Record<string, unknown>[];
}

describe('deps:sync wiring', () => {
  const repo = join(import.meta.dirname, '..', '..');
  const readJson = <T>(...path: string[]): T =>
    JSON.parse(readFileSync(join(repo, ...path), 'utf8')) as T;

  it('package.json has the deps:sync script', () => {
    const { scripts } = readJson<{ scripts?: Record<string, string> }>('package.json');
    assert.equal(scripts?.['deps:sync'], 'node scripts/deps-sync.ts');
  });

  // Synchronous, so the session waits for npm ci before any tool call reaches the gate; listed
  // before the cleanup, which stays in the background. Neither may fail the session.
  it('.claude/settings.json runs deps:sync at session start, before the background cleanup', () => {
    const settings = readJson<{ hooks?: { SessionStart?: SessionStartGroup[] } }>(
      '.claude',
      'settings.json',
    );
    assert.deepEqual(settings.hooks?.SessionStart, [
      {
        matcher: 'startup|resume',
        hooks: [
          {
            type: 'command',
            // biome-ignore lint/suspicious/noTemplateCurlyInString: a placeholder Claude Code expands
            command: 'npm run --silent --prefix "${CLAUDE_PROJECT_DIR}" deps:sync || true',
            shell: 'bash',
            timeout: 600,
          },
          {
            type: 'command',
            command:
              // biome-ignore lint/suspicious/noTemplateCurlyInString: a placeholder Claude Code expands
              'npm run --silent --prefix "${CLAUDE_PROJECT_DIR}" worktrees:clean -- --session-start || true',
            shell: 'bash',
            async: true,
            timeout: 300,
          },
        ],
      },
    ]);
  });
});
